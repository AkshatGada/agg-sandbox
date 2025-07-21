import { ethers } from 'ethers';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// Network configuration for AggLayer Sandbox
const NETWORK_CONFIG = {
  L1: {
    chainId: 1,
    rpc: 'http://localhost:8545',
    bridgeAddress: '0x9fE46736679d2D9a65F0992F2272dE9f3c7fa6e0',
    tokenAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3' // AggERC20_L1
  },
  L2: {
    chainId: 1101,
    rpc: 'http://localhost:8546',
    bridgeAddress: '0x5FbDB2315678afecb367f032d93F642f64180aa3',
    tokenAddress: '0x5FC8d32690cc91D4c39d9d3abcBD16989F875707' // AggERC20_L2
  }
};

// Bridge API configuration
const BRIDGE_API_BASE = 'http://localhost:5577';

interface BridgeTransaction {
  block_num: number;
  block_pos: number;
  from_address: string;
  tx_hash: string;
  calldata: string;
  block_timestamp: number;
  leaf_type: number;
  origin_network: number;
  origin_address: string;
  destination_network: number;
  destination_address: string;
  amount: string;
  metadata: string;
  deposit_count: number;
  is_native_token: boolean;
  bridge_hash: string;
}

interface L1InfoTreeIndex {
  l1_info_tree_index: number;
}

interface ClaimProof {
  l1_info_tree_leaf: {
    block_num: number;
    block_pos: number;
    l1_info_tree_index: number;
    previous_block_hash: string;
    timestamp: number;
    mainnet_exit_root: string;
    rollup_exit_root: string;
    global_exit_root: string;
    hash: string;
  };
}

interface Claim {
  block_num: number;
  block_timestamp: number;
  tx_hash: string;
  global_index: string;
  origin_address: string;
  origin_network: number;
  destination_address: string;
  destination_network: number;
  amount: string;
  from_address: string;
  mainnet_exit_root: string;
}

class BridgeAssetExecutor {
  private l1Provider: ethers.JsonRpcProvider;
  private l2Provider: ethers.JsonRpcProvider;
  private l1Wallet: ethers.Wallet;
  private l2Wallet: ethers.Wallet;
  private userAddress: string;

  constructor() {
    // Get private key from environment
    const privateKey = process.env.PRIVATE_KEY_1 || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
    
    // Initialize providers
    this.l1Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L1.rpc);
    this.l2Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L2.rpc);
    
    // Initialize wallets
    this.l1Wallet = new ethers.Wallet(privateKey, this.l1Provider);
    this.l2Wallet = new ethers.Wallet(privateKey, this.l2Provider);
    this.userAddress = this.l1Wallet.address;
  }

  async checkBalances(): Promise<void> {
    console.log('\n🔍 Checking balances on both networks...\n');
    
    // Check ETH balances
    const l1EthBalance = await this.l1Provider.getBalance(this.userAddress);
    const l2EthBalance = await this.l2Provider.getBalance(this.userAddress);
    
    console.log(`L1 (Ethereum) ETH Balance: ${ethers.formatEther(l1EthBalance)} ETH`);
    console.log(`L2 (Polygon zkEVM) ETH Balance: ${ethers.formatEther(l2EthBalance)} ETH`);
    
    // Check token balances
    const l1TokenBalance = await this.getTokenBalance(NETWORK_CONFIG.L1.tokenAddress, this.l1Provider);
    const l2TokenBalance = await this.getTokenBalance(NETWORK_CONFIG.L2.tokenAddress, this.l2Provider);
    
    console.log(`L1 Token Balance: ${l1TokenBalance} tokens`);
    console.log(`L2 Token Balance: ${l2TokenBalance} tokens\n`);
  }

  private async getTokenBalance(tokenAddress: string, provider: ethers.JsonRpcProvider): Promise<string> {
    try {
      const tokenContract = new ethers.Contract(
        tokenAddress,
        ['function balanceOf(address) view returns (uint256)'],
        provider
      );
      const balance = await tokenContract.balanceOf(this.userAddress);
      return ethers.formatUnits(balance, 18);
    } catch (error) {
      return '0';
    }
  }

  async approveBridge(amount: string): Promise<void> {
    console.log(`\n🔐 Step 1: Approving bridge contract to spend ${amount} tokens on L1...`);
    
    const tokenContract = new ethers.Contract(
      NETWORK_CONFIG.L1.tokenAddress,
      [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)'
      ],
      this.l1Wallet
    );
    
    const amountWei = ethers.parseUnits(amount, 18);
    
    // Check current allowance
    const currentAllowance = await tokenContract.allowance(this.userAddress, NETWORK_CONFIG.L1.bridgeAddress);
    console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 18)} tokens`);
    
    if (currentAllowance < amountWei) {
      const nonce = await this.l1Provider.getTransactionCount(this.userAddress);
      console.log(`Using nonce for approval: ${nonce}`);
      
      const tx = await tokenContract.approve(NETWORK_CONFIG.L1.bridgeAddress, amountWei, { nonce });
      await tx.wait();
      console.log(`✅ Approval transaction confirmed: ${tx.hash}`);
    } else {
      console.log(`✅ Sufficient allowance already exists`);
    }
  }

  async bridgeAsset(amount: string): Promise<string> {
    console.log(`\n🌉 Step 2: Bridging ${amount} tokens from L1 to L2...`);
    
    const bridgeContract = new ethers.Contract(
      NETWORK_CONFIG.L1.bridgeAddress,
      [
        'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes calldata permitData) external'
      ],
      this.l1Wallet
    );

    const amountWei = ethers.parseUnits(amount, 18);
    const destinationAddress = this.userAddress;
    const forceUpdateGlobalExitRoot = true;
    const permitData = '0x';

    // Get the next nonce after the approval transaction
    const nonce = await this.l1Provider.getTransactionCount(this.userAddress);
    console.log(`Using nonce: ${nonce}`);

    const tx = await bridgeContract.bridgeAsset(
      NETWORK_CONFIG.L2.chainId,
      destinationAddress,
      amountWei,
      NETWORK_CONFIG.L1.tokenAddress,
      forceUpdateGlobalExitRoot,
      permitData,
      {
        gasLimit: 3000000,
        nonce: nonce
      }
    );

    console.log(`Transaction hash: ${tx.hash}`);
    const receipt = await tx.wait();
    console.log(`Transaction confirmed in block ${receipt.blockNumber}`);

    return tx.hash;
  }

  async getBridgeDetails(): Promise<BridgeTransaction[]> {
    console.log(`\n📋 Step 3: Getting bridge details...`);
    
    try {
      const response = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/bridges?network_id=${NETWORK_CONFIG.L1.chainId}`);
      const bridges = response.data.bridges || [];
      
      // Filter for transactions from the current user
      const userBridges = bridges.filter((bridge: BridgeTransaction) => 
        bridge.from_address.toLowerCase() === this.userAddress.toLowerCase()
      );
      
      console.log(`\n📊 Found ${userBridges.length} bridge transactions for user ${this.userAddress}`);
      
      if (userBridges.length > 0) {
        // Show the last 3 transactions for debugging
        const recentBridges = userBridges.slice(-3);
        console.log(`\n📋 Recent bridge transactions for user:`);
        recentBridges.forEach((bridge: BridgeTransaction, index: number) => {
          console.log(`  ${index + 1}. Deposit Count: ${bridge.deposit_count}, Hash: ${bridge.bridge_hash}, Amount: ${bridge.amount}`);
        });
        
        const latestUserBridge = userBridges[userBridges.length - 1];
        console.log(`\n🎯 Latest bridge transaction for user:`);
        console.log(`  - Deposit Count: ${latestUserBridge.deposit_count}`);
        console.log(`  - Bridge Hash: ${latestUserBridge.bridge_hash}`);
        console.log(`  - Amount: ${latestUserBridge.amount}`);
        console.log(`  - Destination: ${latestUserBridge.destination_address}`);
        console.log(`  - From Address: ${latestUserBridge.from_address}`);
      } else {
        console.log(`No bridge transactions found for user ${this.userAddress}`);
      }
      
      return userBridges;
    } catch (error) {
      console.error(`Failed to get bridge details:`, error);
      return [];
    }
  }

  async getL1InfoTreeIndex(depositCount: number): Promise<number> {
    console.log(`\n🌳 Step 4: Getting L1 info tree index for deposit count ${depositCount}...`);
    
    try {
      const response = await axios.get(
        `${BRIDGE_API_BASE}/bridge/v1/l1-info-tree-index?network_id=${NETWORK_CONFIG.L1.chainId}&deposit_count=${depositCount}`
      );
      console.log(`API Response:`, JSON.stringify(response.data, null, 2));
      
      // The API returns a raw number, not an object
      const l1InfoTreeIndex = typeof response.data === 'number' ? response.data : response.data.l1_info_tree_index;
      console.log(`L1 Info Tree Index: ${l1InfoTreeIndex}`);
      
      if (l1InfoTreeIndex === undefined || l1InfoTreeIndex === null) {
        throw new Error(`Invalid L1 info tree index returned: ${l1InfoTreeIndex}`);
      }
      
      return l1InfoTreeIndex;
    } catch (error) {
      console.error(`Failed to get L1 info tree index:`, error);
      throw error;
    }
  }

  async prepareTokenMetadata(): Promise<string> {
    console.log(`\n📝 Step 5: Preparing token metadata...`);
    
    // Encode token metadata: name, symbol, decimals
    const metadata = ethers.AbiCoder.defaultAbiCoder().encode(
      ['string', 'string', 'uint8'],
      ['AggERC20', 'AGGERC20', 18]
    );
    
    console.log(`Token metadata prepared: ${metadata}`);
    return metadata;
  }

  async getClaimProof(leafIndex: number, depositCount: number): Promise<ClaimProof> {
    console.log(`\n🔍 Step 6: Getting claim proof for leaf index ${leafIndex}, deposit count ${depositCount}...`);
    
    try {
      const response = await axios.get(
        `${BRIDGE_API_BASE}/bridge/v1/claim-proof?network_id=${NETWORK_CONFIG.L1.chainId}&leaf_index=${leafIndex}&deposit_count=${depositCount}`
      );
      const data: ClaimProof = response.data;
      
      console.log(`Claim proof obtained:`);
      console.log(`  - Mainnet Exit Root: ${data.l1_info_tree_leaf.mainnet_exit_root}`);
      console.log(`  - Rollup Exit Root: ${data.l1_info_tree_leaf.rollup_exit_root}`);
      
      return data;
    } catch (error) {
      console.error(`Failed to get claim proof:`, error);
      throw error;
    }
  }

  async claimAsset(
    depositCount: number,
    mainnetExitRoot: string,
    rollupExitRoot: string,
    amount: string,
    metadata: string
  ): Promise<string> {
    console.log(`\n💰 Step 7: Claiming bridged assets on L2...`);
    
    const bridgeContract = new ethers.Contract(
      NETWORK_CONFIG.L2.bridgeAddress,
      [
        'function claimAsset(uint256 depositCount, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes calldata metadata) external'
      ],
      this.l2Wallet
    );

    const amountWei = ethers.parseUnits(amount, 18);
    const nonce = await this.l2Provider.getTransactionCount(this.userAddress);
    console.log(`Using nonce: ${nonce}`);

    const tx = await bridgeContract.claimAsset(
      depositCount,
      mainnetExitRoot,
      rollupExitRoot,
      NETWORK_CONFIG.L1.chainId, // origin network
      NETWORK_CONFIG.L1.tokenAddress, // origin token address
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

  async verifyClaim(): Promise<void> {
    console.log(`\n✅ Step 8: Verifying claim processing...`);
    
    try {
      const response = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/claims?network_id=${NETWORK_CONFIG.L2.chainId}`);
      const claims: Claim[] = response.data.claims || [];
      
      if (claims.length > 0) {
        const latestClaim = claims[claims.length - 1];
        console.log(`Latest claim:`);
        console.log(`  - Transaction Hash: ${latestClaim.tx_hash}`);
        console.log(`  - Amount: ${latestClaim.amount}`);
        console.log(`  - Destination Address: ${latestClaim.destination_address}`);
        console.log(`  - Block Timestamp: ${latestClaim.block_timestamp}`);
      }
    } catch (error) {
      console.error(`Failed to verify claim:`, error);
    }
  }

  async getMaxUserDepositCount(): Promise<number> {
    // Get the highest deposit count for the user
    const bridges = await this.getBridgeDetails();
    if (bridges.length === 0) return -1;
    return Math.max(...bridges.map(b => b.deposit_count));
  }

  async pollForNewBridge(prevMaxDepositCount: number, maxTries = 15, intervalMs = 2000): Promise<BridgeTransaction> {
    for (let i = 0; i < maxTries; i++) {
      const bridges = await this.getBridgeDetails();
      const newBridge = bridges.find(b => b.deposit_count > prevMaxDepositCount);
      if (newBridge) {
        console.log(`\n✅ Detected new bridge transaction with deposit count ${newBridge.deposit_count}`);
        return newBridge;
      }
      console.log(`⏳ Waiting for new bridge transaction... (attempt ${i + 1}/${maxTries})`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for new bridge transaction to appear in API');
  }

  async executeCompleteBridge(amount: string): Promise<void> {
    console.log(`\n=================================================================`);
    console.log(`                    BRIDGE ASSET EXECUTION`);
    console.log(`=================================================================`);
    console.log(`Amount: ${amount} tokens`);
    console.log(`User Address: ${this.userAddress}`);
    console.log(`=================================================================\n`);

    try {
      // Step 1: Check initial balances
      await this.checkBalances();

      // Step 2: Approve bridge contract
      await this.approveBridge(amount);

      // Step 3: Wait for approval to be confirmed and get fresh nonce
      console.log(`\n⏳ Waiting for approval transaction to be confirmed...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 4: Get current max deposit count for user
      const prevMaxDepositCount = await this.getMaxUserDepositCount();
      console.log(`\n🔎 Previous max deposit count for user: ${prevMaxDepositCount}`);

      // Step 5: Bridge assets
      const bridgeTxHash = await this.bridgeAsset(amount);

      // Step 6: Poll for new bridge transaction
      const latestBridge = await this.pollForNewBridge(prevMaxDepositCount);
      const depositCount = latestBridge.deposit_count;
      
      console.log(`\n🔍 Using deposit count: ${depositCount} for bridge transaction:`);
      console.log(`  - Bridge Hash: ${latestBridge.bridge_hash}`);
      console.log(`  - Amount: ${latestBridge.amount}`);
      console.log(`  - From: ${latestBridge.from_address}`);
      console.log(`  - To: ${latestBridge.destination_address}`);

      // Wait for L2 state to be ready
      console.log(`\n⏳ Waiting 30 seconds for L2 state to be ready for claim...`);
      await new Promise(resolve => setTimeout(resolve, 30000));

      // Step 7: Get L1 info tree index
      const leafIndex = await this.getL1InfoTreeIndex(depositCount);

      // Step 8: Prepare token metadata
      const metadata = await this.prepareTokenMetadata();

      // Step 9: Get claim proof
      const claimProof = await this.getClaimProof(leafIndex, depositCount);

      // Step 10: Claim assets with retry logic
      let claimTxHash;
      let claimSuccess = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`\n🚀 Attempting claim (try ${attempt}/3)...`);
          claimTxHash = await this.claimAsset(
            depositCount,
            claimProof.l1_info_tree_leaf.mainnet_exit_root,
            claimProof.l1_info_tree_leaf.rollup_exit_root,
            amount,
            metadata
          );
          claimSuccess = true;
          break;
        } catch (err) {
          console.error(`\n⚠️  Claim attempt ${attempt} failed:`, err);
          if (attempt < 3) {
            console.log('⏳ Waiting 10 seconds before retrying claim...');
            await new Promise(resolve => setTimeout(resolve, 10000));
          }
        }
      }
      if (!claimSuccess) {
        throw new Error('Claim failed after 3 attempts');
      }

      // Step 11: Verify claim
      await this.verifyClaim();

      // Step 12: Check final balances
      console.log(`\n📊 Final balances after bridge:`);
      await this.checkBalances();

      console.log(`\n🎉 Bridge asset execution completed successfully!`);
      console.log(`Bridge Transaction: ${bridgeTxHash}`);
      console.log(`Claim Transaction: ${claimTxHash}`);

    } catch (error) {
      console.error(`\n❌ Error during bridge execution:`, error);
      throw error;
    }
  }
}

// Main execution function
async function main() {
  const executor = new BridgeAssetExecutor();
  
  try {
    // Execute a complete bridge of 10 tokens
    await executor.executeCompleteBridge('10');
  } catch (error) {
    console.error('Bridge execution failed:', error);
    process.exit(1);
  }
}

// Run the script if executed directly
if (require.main === module) {
  main().then(() => {
    console.log('\n✅ Script completed successfully!');
    process.exit(0);
  }).catch((error) => {
    console.error('\n❌ Script failed:', error);
    process.exit(1);
  });
}

export default BridgeAssetExecutor; 