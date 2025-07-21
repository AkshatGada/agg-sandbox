import { ethers } from 'ethers';
import dotenv from 'dotenv';
import axios from 'axios';

// Load environment variables
dotenv.config();

// Network configuration for AggLayer Sandbox (adapted from bridge asset script)
const NETWORK_CONFIG = {
  L1: {
    chainId: 1,
    rpc: 'http://localhost:8545',
    bridgeExtension: '0x032B5F56CDa48Ee1c3C6B8DDbd4a9794E01DBfb8', // BridgeExtension L1
    token: '0xC54c6f1296C01B840927B303Fd5DFea076599feC', // AggERC20_L1
  },
  L2: {
    chainId: 1101,
    rpc: 'http://localhost:8546',
    mainBridge: '0x1613beB3B2C4f22Ee086B2b38C1476A3cE7f78E8', // Main bridge contract L2
    token: '0x70e0bA845a1A0F2DA3359C97E0285013525FFC49', // AggERC20_L2
  }
};

// Bridge API configuration
const BRIDGE_API_BASE = 'http://localhost:5577';

// Interfaces (reused from bridge asset script)
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

class BridgeAndCallExecutor {
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
    const l1Eth = await this.l1Provider.getBalance(this.userAddress);
    const l2Eth = await this.l2Provider.getBalance(this.userAddress);
    
    console.log(`L1 (Ethereum) ETH Balance: ${ethers.formatEther(l1Eth)} ETH`);
    console.log(`L2 (Polygon zkEVM) ETH Balance: ${ethers.formatEther(l2Eth)} ETH`);
    
    // Check token balances
    const l1Token = await this.getTokenBalance(NETWORK_CONFIG.L1.token, this.l1Provider);
    const l2Token = await this.getTokenBalance(NETWORK_CONFIG.L2.token, this.l2Provider);
    
    console.log(`L1 Token Balance: ${l1Token} tokens`);
    console.log(`L2 Token Balance: ${l2Token} tokens\n`);
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

  async approveBridgeExtension(amount: string): Promise<void> {
    console.log(`\n🔐 Step 1: Approving bridge extension contract to spend ${amount} tokens on L1...`);
    
    const tokenContract = new ethers.Contract(
      NETWORK_CONFIG.L1.token,
      [
        'function approve(address spender, uint256 amount) returns (bool)',
        'function allowance(address owner, address spender) view returns (uint256)'
      ],
      this.l1Wallet
    );
    
    const amountWei = ethers.parseUnits(amount, 18);
    
    // Check current allowance
    const currentAllowance = await tokenContract.allowance(this.userAddress, NETWORK_CONFIG.L1.bridgeExtension);
    console.log(`Current allowance: ${ethers.formatUnits(currentAllowance, 18)} tokens`);
    
    if (currentAllowance < amountWei) {
      const nonce = await this.l1Provider.getTransactionCount(this.userAddress);
      console.log(`Using nonce for approval: ${nonce}`);
      
      const tx = await tokenContract.approve(NETWORK_CONFIG.L1.bridgeExtension, amountWei, { nonce });
      await tx.wait();
      console.log(`✅ Approval transaction confirmed: ${tx.hash}`);
    } else {
      console.log(`✅ Sufficient allowance already exists`);
    }
  }

  async getPrecalculatedL2TokenAddress(): Promise<string> {
    console.log(`\n📍 Step 2: Getting precalculated L2 token address...`);
    const bridgeContract = new ethers.Contract(
      NETWORK_CONFIG.L2.mainBridge,
      ['function precalculatedWrapperAddress(uint32 originNetwork, address originTokenAddress, string calldata name, string calldata symbol, uint8 decimals) view returns (address)'],
      this.l2Provider
    );
    const l2TokenAddress = await bridgeContract.precalculatedWrapperAddress(
      NETWORK_CONFIG.L1.chainId,
      NETWORK_CONFIG.L1.token,
      'AggERC20',
      'AGGERC20',
      18
    );
    console.log(`Precalculated L2 Token Address: ${l2TokenAddress}`);
    return l2TokenAddress;
  }

  async bridgeAndCall(amount: string, transferTo: string): Promise<string> {
    console.log(`\n🌉 Step 3: Executing bridge and call for ${amount} tokens from L1 to L2...`);
    
    const bridgeExtension = new ethers.Contract(
      NETWORK_CONFIG.L1.bridgeExtension,
      ['function bridgeAndCall(address token, uint256 amount, uint32 destinationNetwork, address target, address fallbackAddress, bytes calldata callData, bool forceUpdateGlobalExitRoot) external'],
      this.l1Wallet
    );

    const amountWei = ethers.parseUnits(amount, 18);
    
    // Encode call data for transfer (example: transfer 1 token to transferTo address)
    const callData = new ethers.Interface(['function transfer(address to, uint256 amount)']).encodeFunctionData('transfer', [transferTo, ethers.parseUnits('1', 18)]);

    const l2TokenAddress = await this.getPrecalculatedL2TokenAddress();
    const fallbackAddress = this.userAddress; // Fallback if call fails
    const forceUpdateGlobalExitRoot = true;

    const nonce = await this.l1Provider.getTransactionCount(this.userAddress);
    console.log(`Using nonce: ${nonce}`);

    const tx = await bridgeExtension.bridgeAndCall(
      NETWORK_CONFIG.L1.token,
      amountWei,
      NETWORK_CONFIG.L2.chainId,
      l2TokenAddress,
      fallbackAddress,
      callData,
      forceUpdateGlobalExitRoot,
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
    console.log(`\n📋 Step 4: Getting bridge details...`);
    
    try {
      const response = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/bridges?network_id=${NETWORK_CONFIG.L1.chainId}`);
      const bridges = response.data.bridges || [];
      
      // Filter for transactions from the current user
      const userBridges = bridges.filter((bridge: BridgeTransaction) => 
        bridge.from_address.toLowerCase() === this.userAddress.toLowerCase()
      );
      
      console.log(`\n📊 Found ${userBridges.length} bridge transactions for user ${this.userAddress}`);
      return userBridges;
    } catch (error) {
      console.error(`Failed to get bridge details:`, error);
      return [];
    }
  }

  async verifyExecution(): Promise<void> {
    console.log(`\n✅ Step 5: Verifying automatic execution...`);
    
    try {
      const response = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/claims?network_id=${NETWORK_CONFIG.L2.chainId}`);
      const claims: Claim[] = response.data.claims || [];
      
      if (claims.length > 0) {
        const latestClaim = claims[claims.length - 1];
        console.log(`Latest execution:`);
        console.log(`  - Transaction Hash: ${latestClaim.tx_hash}`);
        console.log(`  - Amount: ${latestClaim.amount}`);
        console.log(`  - Destination Address: ${latestClaim.destination_address}`);
        console.log(`  - Block Timestamp: ${latestClaim.block_timestamp}`);
      } else {
        console.log('No executions found yet.');
      }
    } catch (error) {
      console.error(`Failed to verify execution:`, error);
    }
  }

  async pollForExecution(maxTries = 60, intervalMs = 5000): Promise<void> {
    for (let i = 0; i < maxTries; i++) {
      const bridges = await this.getBridgeDetails();
      const messageBridge = bridges.find((b: any) => b.leaf_type === 1);
      console.log(`[Polling] Attempt ${i + 1}/${maxTries} | Total user bridge txs: ${bridges.length}`);
      if (messageBridge) {
        console.log(`\n✅ Detected automatic execution (message bridge found, deposit_count: ${messageBridge.deposit_count}, tx_hash: ${messageBridge.tx_hash})`);
        return;
      }
      console.log(`[Polling] No message bridge found yet. Waiting ${intervalMs / 1000}s before next attempt...`);
      await new Promise(resolve => setTimeout(resolve, intervalMs));
    }
    throw new Error('Timed out waiting for automatic execution. Consider manual verification or claim.');
  }

  async executeCompleteBridgeAndCall(amount: string, transferTo: string): Promise<void> {
    console.log(`\n=================================================================`);
    console.log(`                    BRIDGE AND CALL EXECUTION`);
    console.log(`=================================================================`);
    console.log(`Amount: ${amount} tokens`);
    console.log(`Transfer To (on L2): ${transferTo}`);
    console.log(`User Address: ${this.userAddress}`);
    console.log(`=================================================================\n`);

    try {
      // Step 1: Check initial balances
      await this.checkBalances();

      // Step 2: Approve bridge extension
      await this.approveBridgeExtension(amount);

      // Step 3: Wait for approval confirmation
      console.log(`\n⏳ Waiting for approval transaction to be confirmed...`);
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 4: Execute bridge and call
      const txHash = await this.bridgeAndCall(amount, transferTo);

      // No polling or automatic claim verification here
      console.log(`\nBridge and call transaction submitted. Tx hash: ${txHash}`);
      console.log(`\nYou can now manually check for claim confirmation using CLI tools.`);

    } catch (error) {
      console.error(`\n❌ Error during bridge and call execution:`, error);
      throw error;
    }
  }
}

// Main execution function
async function main() {
  const executor = new BridgeAndCallExecutor();
  
  try {
    // Example: Bridge 10 tokens and transfer 1 to a sample L2 address
    const transferTo = '0x15d34AAf54267DB7D7c367839AAf71A00a2C6A65'; // Anvil account 3
    await executor.executeCompleteBridgeAndCall('10', transferTo);
  } catch (error) {
    console.error('Bridge and call execution failed:', error);
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

export default BridgeAndCallExecutor;
