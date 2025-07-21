import { ethers } from 'ethers';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

const NETWORK_CONFIG = {
  L1: {
    chainId: 1,
    rpc: 'http://localhost:8545',
    bridgeAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
  },
  L2: {
    chainId: 1101,
    rpc: 'http://localhost:8546',
    bridgeAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
  }
};

const BRIDGE_API_BASE = 'http://localhost:5577';

class BridgeEthExecutor {
  private l1Provider: ethers.JsonRpcProvider;
  private l2Provider: ethers.JsonRpcProvider;
  private l1Wallet: ethers.Wallet;
  private l2Wallet: ethers.Wallet;
  private userAddress: string;

  constructor() {
    const privateKey = process.env.PRIVATE_KEY_1 || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    this.l1Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L1.rpc);
    this.l2Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L2.rpc);
    this.l1Wallet = new ethers.Wallet(privateKey, this.l1Provider);
    this.l2Wallet = new ethers.Wallet(privateKey, this.l2Provider);
    this.userAddress = this.l1Wallet.address;
  }

  async checkBalances(): Promise<void> {
    const l1Eth = await this.l1Provider.getBalance(this.userAddress);
    const l2Eth = await this.l2Provider.getBalance(this.userAddress);
    console.log(`L1 ETH: ${ethers.formatEther(l1Eth)} | L2 ETH: ${ethers.formatEther(l2Eth)}`);
  }

  async getBridgeDetails(): Promise<any[]> {
    try {
      const response = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/bridges?network_id=${NETWORK_CONFIG.L1.chainId}`);
      const bridges = response.data.bridges || [];
      // Filter for ETH bridges from the current user
      return bridges.filter((bridge: any) =>
        bridge.from_address.toLowerCase() === this.userAddress.toLowerCase() && bridge.is_native_token
      );
    } catch (error) {
      console.error('Failed to get bridge details:', error);
      return [];
    }
  }

  async getMaxUserDepositCount(): Promise<number> {
    const bridges = await this.getBridgeDetails();
    if (bridges.length === 0) return -1;
    return Math.max(...bridges.map(b => b.deposit_count));
  }

  async pollForNewBridge(prevMaxDepositCount: number, maxTries = 30, intervalMs = 2000): Promise<any> {
    for (let i = 0; i < maxTries; i++) {
      const bridges = await this.getBridgeDetails();
      const depositCounts = bridges.map(b => b.deposit_count);
      console.log(`[DEBUG] Poll ${i + 1}: Deposit counts seen:`, depositCounts);
      const newBridge = bridges.find(b => b.deposit_count > prevMaxDepositCount);
      if (newBridge) {
        console.log(`\n✅ Detected new ETH bridge transaction with deposit count ${newBridge.deposit_count}`);
        return newBridge;
      }
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    // After timeout, print all bridges for the user
    const bridges = await this.getBridgeDetails();
    console.error('[DEBUG] Polling timed out. Final bridge deposit counts:', bridges.map(b => b.deposit_count));
    throw new Error('Timed out waiting for new ETH bridge transaction to appear in API');
  }

  async getL1InfoTreeIndex(depositCount: number): Promise<number> {
    try {
      const response = await axios.get(
        `${BRIDGE_API_BASE}/bridge/v1/l1-info-tree-index?network_id=${NETWORK_CONFIG.L1.chainId}&deposit_count=${depositCount}`
      );
      return typeof response.data === 'number' ? response.data : response.data.l1_info_tree_index;
    } catch (error) {
      console.error('Failed to get L1 info tree index:', error);
      throw error;
    }
  }

  async getClaimProof(leafIndex: number, depositCount: number): Promise<any> {
    try {
      const response = await axios.get(
        `${BRIDGE_API_BASE}/bridge/v1/claim-proof?network_id=${NETWORK_CONFIG.L1.chainId}&leaf_index=${leafIndex}&deposit_count=${depositCount}`
      );
      return response.data;
    } catch (error) {
      console.error('Failed to get claim proof:', error);
      throw error;
    }
  }

  async claimEth(
    depositCount: number,
    mainnetExitRoot: string,
    rollupExitRoot: string,
    amount: string
  ): Promise<string> {
    const bridgeContract = new ethers.Contract(
      NETWORK_CONFIG.L2.bridgeAddress,
      [
        'function claimAsset(uint256 depositCount, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes calldata metadata) external'
      ],
      this.l2Wallet
    );
    const amountWei = ethers.parseEther(amount);
    const nonce = await this.l2Provider.getTransactionCount(this.userAddress);
    // ETH metadata is empty
    const metadata = '0x';
    const tx = await bridgeContract.claimAsset(
      depositCount,
      mainnetExitRoot,
      rollupExitRoot,
      NETWORK_CONFIG.L1.chainId, // origin network
      '0x0000000000000000000000000000000000000000', // origin token address (ETH)
      NETWORK_CONFIG.L2.chainId, // destination network
      this.userAddress, // destination address
      amountWei,
      metadata,
      {
        gasLimit: 3000000,
        nonce: nonce
      }
    );
    console.log(`Claim transaction hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Claim transaction confirmed in block ${receipt.blockNumber}`);
    return tx.hash;
  }

  async bridgeEth(amount: string): Promise<string> {
    console.log(`\n🌉 Bridging ${amount} ETH from L1 to L2...`);
    const bridgeContract = new ethers.Contract(
      NETWORK_CONFIG.L1.bridgeAddress,
      [
        'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes calldata permitData) external payable'
      ],
      this.l1Wallet
    );
    const amountWei = ethers.parseEther(amount);
    const destinationAddress = this.userAddress;
    const tokenAddress = '0x0000000000000000000000000000000000000000';
    const forceUpdateGlobalExitRoot = true;
    const permitData = '0x';
    const nonce = await this.l1Provider.getTransactionCount(this.userAddress);
    const tx = await bridgeContract.bridgeAsset(
      NETWORK_CONFIG.L2.chainId,
      destinationAddress,
      amountWei,
      tokenAddress,
      forceUpdateGlobalExitRoot,
      permitData,
      {
        gasLimit: 3000000,
        nonce,
        value: amountWei
      }
    );
    console.log(`Transaction hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Transaction confirmed in block ${receipt.blockNumber}`);
    return tx.hash;
  }

  async execute(amount: string): Promise<void> {
    console.log('--- Initial ETH Balances ---');
    await this.checkBalances();

    // Step 1: Get current max deposit count for user BEFORE sending the bridge transaction
    const prevMaxDepositCount = await this.getMaxUserDepositCount();
    console.log(`[DEBUG] Previous max ETH deposit count for user: ${prevMaxDepositCount}`);

    // Step 2: Bridge ETH
    await this.bridgeEth(amount);

    // Step 2.5: Wait 5 seconds to allow backend to index the new bridge
    console.log(`\n⏳ Waiting 5 seconds for backend to index the new bridge...`);
    await new Promise(resolve => setTimeout(resolve, 5000));

    // Step 3: Print latest deposit count after sending bridge
    const latestDepositCount = await this.getMaxUserDepositCount();
    console.log(`[DEBUG] Latest max ETH deposit count for user after sending bridge: ${latestDepositCount}`);

    // Step 4: Poll for new ETH bridge transaction (increase maxTries to 30)
    const latestBridge = await this.pollForNewBridge(prevMaxDepositCount, 30, 2000);
    const depositCount = latestBridge.deposit_count;
    console.log(`\n🔍 Using deposit count: ${depositCount} for ETH bridge transaction`);

    // Step 5: Wait for L2 state to be ready
    console.log(`\n⏳ Waiting 30 seconds for L2 state to be ready for claim...`);
    await new Promise(resolve => setTimeout(resolve, 30000));

    // Step 6: Get L1 info tree index
    const leafIndex = await this.getL1InfoTreeIndex(depositCount);

    // Step 7: Get claim proof
    const claimProof = await this.getClaimProof(leafIndex, depositCount);

    // Step 8: Claim ETH with retry logic
    let claimTxHash;
    let claimSuccess = false;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        console.log(`\n🚀 Attempting ETH claim (try ${attempt}/3)...`);
        claimTxHash = await this.claimEth(
          depositCount,
          claimProof.l1_info_tree_leaf.mainnet_exit_root,
          claimProof.l1_info_tree_leaf.rollup_exit_root,
          amount
        );
        claimSuccess = true;
        break;
      } catch (err) {
        console.error(`\n⚠️  ETH claim attempt ${attempt} failed:`, err);
        if (attempt < 3) {
          console.log('⏳ Waiting 10 seconds before retrying ETH claim...');
          await new Promise(resolve => setTimeout(resolve, 10000));
        }
      }
    }
    if (!claimSuccess) {
      throw new Error('ETH claim failed after 3 attempts');
    }

    // Step 9: Final balances
    console.log('--- Final ETH Balances ---');
    await this.checkBalances();
    console.log('✅ ETH bridge and claim complete!');
  }
}

async function main() {
  const amount = process.argv[2] || '0.01';
  const executor = new BridgeEthExecutor();
  await executor.execute(amount);
}

if (require.main === module) {
  main().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });
}

export default BridgeEthExecutor; 