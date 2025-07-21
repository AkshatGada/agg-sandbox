# AggLayer Sandbox Bridge-and-Call & Claim Proofs Findings

- The bridge-and-call flow using AggERC20 works: tokens are bridged and claims are created on L2 (network 1101).
- Claims for bridge transactions are visible using the CLI command:
  - `aggsandbox show claims --network-id 1101`
- However, fetching claim proofs for specific deposit counts (e.g., via `aggsandbox show claim-proof --network-id 1101 --deposit-count <count>`) consistently returns a 500 Internal Server Error from the backend API.
- This means:
  - The bridge and claim creation logic is functional.
  - The claim proof API endpoint is currently broken or misconfigured in the sandbox environment.
- Recommendation: Backend/API maintainers should investigate the `/bridge/v1/claim-proof` endpoint and service logs to restore claim proof functionality for end-to-end testing.

# Bridge and Claim Proof Manual Check Findings

- Manual bridge and claim proof flow (following COMMANDS.md) works as expected:
  - Bridge transaction is indexed and visible in `aggsandbox show bridges`.
  - L1 info tree index and claim proof are available via CLI/API.
  - Claim is processed instantly on L2 in sandbox mode.
- No API errors or missing data were encountered during manual checks.
- The backend and API are healthy and functioning as documented.
- If the script times out or fails to detect the new bridge, it is likely due to a race condition or polling logic issue, not an infrastructure problem.
- Recommendation: Add debug output to the script to print all deposit counts seen during polling and after sending the bridge transaction, to help catch and diagnose race conditions.

agada@Polygon-RWQLQGXX9P agg-sandbox % npx ts-node src/bridge-eth.ts 0.01
--- Initial ETH Balances ---
L1 ETH: 9999.513498700397346913 | L2 ETH: 9999.677212350283020743

🔎 Previous max ETH deposit count for user: 9

🌉 Bridging 0.01 ETH from L1 to L2...
Transaction hash: 0xf6e9d4afe3a97609f1b4e8e28db07f2372c33a20276bad37db0906e522293cef
Transaction confirmed in block 38
⏳ Waiting for new ETH bridge transaction... (attempt 1/15)

✅ Detected new ETH bridge transaction with deposit count 19

🔍 Using deposit count: 19 for ETH bridge transaction

⏳ Waiting 30 seconds for L2 state to be ready for claim...

🚀 Attempting ETH claim (try 1/3)...
Claim transaction hash: 0xe7ec18a99e9dc0c7f6c0a47f4cf5fb08169c963d234ef7617f0fe7cdfe447cbb
Claim transaction confirmed in block 39
--- Final ETH Balances ---
L1 ETH: 9999.503079067701095553 | L2 ETH: 9999.68708825728613777
✅ ETH bridge and claim complete!

agada@Polygon-RWQLQGXX9P agg-sandbox % npx ts-node src/bridge-eth.ts 0.01
--- Initial ETH Balances ---
L1 ETH: 9999.503079067701095553 | L2 ETH: 9999.68708825728613777

🔎 Previous max ETH deposit count for user: 19

🌉 Bridging 0.01 ETH from L1 to L2...
Transaction hash: 0x0016125cea3ea55733039aacdf566defb5f15796f87eaea6f8794f219455c2e6
Transaction confirmed in block 39
⏳ Waiting for new ETH bridge transaction... (attempt 1/15)
⏳ Waiting for new ETH bridge transaction... (attempt 2/15)

✅ Detected new ETH bridge transaction with deposit count 20

🔍 Using deposit count: 20 for ETH bridge transaction

⏳ Waiting 30 seconds for L2 state to be ready for claim...

🚀 Attempting ETH claim (try 1/3)...
Claim transaction hash: 0xd028c360b596c1ef222e45de847f3925a5de2663b93de8ee6bb8fd70ce392bbf
Claim transaction confirmed in block 41
--- Final ETH Balances ---
L1 ETH: 9999.492673400650357553 | L2 ETH: 9999.696964367022056991
✅ ETH bridge and claim complete!













Great question! Here’s a clear explanation of what “the backend” is in your AggLayer sandbox environment, and its exact role in the bridging and claim flows:

---

## **What is “the Backend” in AggLayer Sandbox?**

**The backend** refers to the **AggKit service** (sometimes called “bridge-service” or “API server”) that runs as part of your local sandbox environment. It is a REST API server, typically running on port `5577` (`http://localhost:5577`), and is responsible for orchestrating, indexing, and exposing all cross-chain bridge activity in the sandbox.

---

### **Key Responsibilities of the Backend (AggKit)**

1. **Indexing On-Chain Events**
   - Listens to both L1 and L2 blockchains for bridge-related events (deposits, claims, messages, etc.).
   - Indexes these events in a local database for fast querying.

2. **Providing a REST API**
   - Exposes endpoints like:
     - `/bridge/v1/bridges` — List all bridge transactions.
     - `/bridge/v1/claims` — List all claims.
     - `/bridge/v1/claim-proof` — Generate Merkle proofs for claims.
     - `/bridge/v1/l1-info-tree-index` — Get info tree indices for claims.
   - These endpoints are used by the CLI (`aggsandbox show ...` commands) and scripts to fetch bridge/claim data and proofs.

3. **Coordinating the Bridging Flow**
   - Acts as the “glue” between the blockchain nodes (Anvil L1/L2) and your CLI/scripts.
   - Ensures that when you bridge assets, the corresponding events are detected, indexed, and made available for claim processing.

4. **Generating Proofs**
   - Builds and serves Merkle proofs and other cryptographic data needed to claim assets on the destination chain.
   - Without the backend, you cannot fetch the necessary proofs to complete a claim.

5. **Sandbox Mode Features**
   - In “sandbox mode,” the backend can enable instant claims, automatic execution, and other developer-friendly features for rapid testing.

---

### **Why is the Backend Critical?**

- **Without the backend running and healthy:**
  - The CLI cannot show bridges, claims, or generate proofs.
  - Scripts that rely on the API will fail (e.g., polling for new bridges, fetching claim proofs).
  - The end-to-end bridge and claim flow cannot be completed manually or automatically.

- **The backend is NOT:**
  - The blockchain node itself (that’s Anvil L1/L2).
  - The smart contracts (those are deployed on the nodes).
  - The frontend UI (if any).

---

### **Summary Table**

| Component         | Role/Responsibility                                      |
|-------------------|---------------------------------------------------------|
| Anvil L1/L2       | Simulated blockchains (Ethereum, Polygon zkEVM)         |
| Smart Contracts   | Bridge, claim, and extension logic (on-chain)           |
| **Backend (AggKit)** | Indexes events, exposes REST API, generates proofs, coordinates bridging |
| CLI/Scripts       | User interface to interact with backend and contracts   |

---

**In short:**  
The backend (AggKit) is the “brain” of the sandbox, making all bridge/claim data accessible and actionable for your CLI and scripts. If it’s down, you lose the ability to see, prove, or claim any cross-chain activity in the sandbox.

Let me know if you want a diagram or more details on any part!



bbf6a41484ef   ametelnethermind/aggsandbox-aggkit:latest     "/app/entrypoint.sh …"   13 hours ago    Exited (255) 13 hours ago   0.0.0.0:5577->5577/tcp, 0.0.0.0:8080->8080/tcp, 0.0.0.0:8555->8555/tcp   sandbox-aggkit-1
6af42d756589   ametelnethermind/aggsandbox-deployer:latest   "/app/wait-and-deplo…"   13 hours ago    Exited (0) 13 hours ago                                                                              sandbox-contract-deployer-1
23c392254624   ametelnethermind/aggsandbox-anvil:latest      "/usr/local/bin/entr…"   13 hours ago    Exited (255) 13 hours ago   0.0.0.0:8545->8545/tcp                                                   sandbox-anvil-l1-1
d60eefc48fd4   ametelnethermind/aggsandbox-anvil:latest      "/usr/local/bin/entr…"   13 hours ago    Exited (255) 13 hours ago   0.0.0.0:8546->8545/tcp                                                   sandbox-anvil-l2-1
caa0ca69d012   kurtosistech/core:1.0.0                       "/bin/sh -c ./api-co…"   3 months ago    Exited (2) 2 days ago       127.0.0.1:55000->7443/tcp                                                kurtosis-api--7c31c457321940d084419bc2c6ab8c74


Key Takeaways:
AggKit startup is non-deterministic:
If it starts too soon after contract deployment, it may not see the contracts and will fail.
If it starts after the node is fully ready and contracts are indexed, it works fine.
This is a classic race condition in multi-service environments where one service depends on the state created by another.