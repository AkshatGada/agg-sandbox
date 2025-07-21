import { ethers } from 'ethers';
import dotenv from 'dotenv';
import axios from 'axios';

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

async function main() {
  const privateKey = process.env.PRIVATE_KEY_1 || '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
  const l1Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L1.rpc);
  const l2Provider = new ethers.JsonRpcProvider(NETWORK_CONFIG.L2.rpc);
  const l1Wallet = new ethers.Wallet(privateKey, l1Provider);
  const l2Wallet = new ethers.Wallet(privateKey, l2Provider);
  const userAddress = l1Wallet.address;

  // 1. Check balances
  const l1Eth = await l1Provider.getBalance(userAddress);
  const l2Eth = await l2Provider.getBalance(userAddress);
  console.log(`L1 ETH: ${ethers.formatEther(l1Eth)} | L2 ETH: ${ethers.formatEther(l2Eth)}`);

  // 2. Bridge ETH (native)
  const amount = '0.01';
  const amountWei = ethers.parseEther(amount);
  const bridgeContract = new ethers.Contract(
    NETWORK_CONFIG.L1.bridgeAddress,
    [
      'function bridgeAsset(uint32 destinationNetwork, address destinationAddress, uint256 amount, address token, bool forceUpdateGlobalExitRoot, bytes calldata permitData) external payable'
    ],
    l1Wallet
  );
  const bridgeTx = await bridgeContract.bridgeAsset(
    NETWORK_CONFIG.L2.chainId,
    userAddress,
    amountWei,
    ethers.ZeroAddress,
    true,
    '0x',
    { gasLimit: 3000000, value: amountWei }
  );
  console.log(`Bridge tx sent: ${bridgeTx.hash}`);
  await bridgeTx.wait();
  console.log('Bridge tx confirmed.');

  // 3. Poll for bridge event in API
  let depositCount = -1;
  for (let i = 0; i < 10; i++) {
    const resp = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/bridges?network_id=${NETWORK_CONFIG.L1.chainId}`);
    const bridges = resp.data.bridges || [];
    const userBridges = bridges.filter((b: any) => b.from_address.toLowerCase() === userAddress.toLowerCase() && b.is_native_token);
    if (userBridges.length > 0) {
      depositCount = userBridges[userBridges.length - 1].deposit_count;
      console.log(`Detected ETH bridge event. Deposit count: ${depositCount}`);
      break;
    }
    await new Promise(r => setTimeout(r, 2000));
  }
  if (depositCount === -1) throw new Error('ETH bridge event not detected in API');

  // 4. Get L1 info tree index
  const l1InfoResp = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/l1-info-tree-index?network_id=${NETWORK_CONFIG.L1.chainId}&deposit_count=${depositCount}`);
  const leafIndex = typeof l1InfoResp.data === 'number' ? l1InfoResp.data : l1InfoResp.data.l1_info_tree_index;
  console.log(`L1 info tree index: ${leafIndex}`);

  // 5. Prepare empty metadata for ETH
  const metadata = '0x';

  // 6. Get claim proof
  const claimProofResp = await axios.get(`${BRIDGE_API_BASE}/bridge/v1/claim-proof?network_id=${NETWORK_CONFIG.L1.chainId}&leaf_index=${leafIndex}&deposit_count=${depositCount}`);
  const claimProof = claimProofResp.data.l1_info_tree_leaf;

  // 7. Claim ETH on L2
  const l2Bridge = new ethers.Contract(
    NETWORK_CONFIG.L2.bridgeAddress,
    [
      'function claimAsset(uint256 depositCount, bytes32 mainnetExitRoot, bytes32 rollupExitRoot, uint32 originNetwork, address originTokenAddress, uint32 destinationNetwork, address destinationAddress, uint256 amount, bytes calldata metadata) external'
    ],
    l2Wallet
  );
  const claimTx = await l2Bridge.claimAsset(
    depositCount,
    claimProof.mainnet_exit_root,
    claimProof.rollup_exit_root,
    NETWORK_CONFIG.L1.chainId,
    ethers.ZeroAddress,
    NETWORK_CONFIG.L2.chainId,
    userAddress,
    amountWei,
    metadata,
    { gasLimit: 3000000 }
  );
  console.log(`Claim tx sent: ${claimTx.hash}`);
  await claimTx.wait();
  console.log('Claim tx confirmed.');

  // 8. Check final balances
  const l1Final = await l1Provider.getBalance(userAddress);
  const l2Final = await l2Provider.getBalance(userAddress);
  console.log(`Final L1 ETH: ${ethers.formatEther(l1Final)} | Final L2 ETH: ${ethers.formatEther(l2Final)}`);
}

main().then(() => {
  console.log('✅ Katana ETH bridge test completed!');
  process.exit(0);
}).catch((err) => {
  console.error('❌ Katana ETH bridge test failed:', err);
  process.exit(1);
}); 