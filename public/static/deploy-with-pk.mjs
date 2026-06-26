// ============================================================
// deploy-with-pk.mjs — AgentExecutor.sol deploy via chave privada própria
// Arc Testnet · Chain ID 5042002 · RPC https://rpc.testnet.arc.network
//
// Uso:
//   1. Criar arquivo .my-deployer.json com: {"privateKey":"0xSUA_CHAVE"}
//      OU definir variável de ambiente: DEPLOY_PK=0xSUA_CHAVE
//   2. node deploy-with-pk.mjs
//
// Resultado:
//   - deployment.json com endereço do contrato e ABI
//   - Instruções para configurar no Cloudflare
// ============================================================
import { ethers } from 'ethers';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Network ─────────────────────────────────────────────────────────────────
const RPC_URL  = 'https://rpc.testnet.arc.network';
const CHAIN_ID = 5042002;
const EXPLORER = 'https://testnet.arcscan.app';

// ─── Token addresses on Arc Testnet ──────────────────────────────────────────
const USDC_ADDR = '0x3600000000000000000000000000000000000000';
const EURC_ADDR = '0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a';

// ─── Compiled bytecode (solc 0.8.34 viaIR, optimization 200 runs) ────────────
// Compiled from: AgentExecutor.sol
// Source hash: sha256(AgentExecutor.sol) = see IPFS in contract comments
const BYTECODE = '0x' + '60a080604052346102615761157d803803809161001c8285610265565b83398101906040818303126102615780516001600160401b038111610261578261004791830161029c565b60208201519092906001600160401b03811161026157610067920161029c565b6402540be4006006555f80546001600160a01b0319163317905560408051906100909082610265565b600d81526c20b3b2b73a22bc32b1baba37b960991b602090910152604080517f6823328dbe0dd69959b19f2f51344f07fdfd98016d31b834b855e7e451a70899916100db9082610265565b600181526020810190603160f81b82525190206040519060208201927f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8452604083015260608201524660808201523060a082015260a0815261013f60c082610265565b5190206080525f5b82518110156101c3576001906001600160a01b036101658286610312565b51165f52600260205260405f208260ff198254161790557f4b36b2e66f38ed349bec532105790177f1283bcbc094e6cd48565195d3033c436040838060a01b036101af8488610312565b51168151908152846020820152a101610147565b505f5b8151811015610242576001906001600160a01b036101e48285610312565b51165f52600360205260405f208260ff198254161790557fdcb2804db02b95bdd568fd11a31c5577ffdf36538c0f670e92930d9c1e8518ab6040838060a01b0361022e8487610312565b51168151908152846020820152a1016101c6565b604051611242908161033b8239608051818181610c9b0152610fd00152f35b5f80fd5b601f909101601f19168101906001600160401b0382119082101761028857604052565b634e487b7160e01b5f52604160045260245ffd5b81601f82011215610261578051916001600160401b038311610288578260051b91604051936102ce6020850186610265565b845260208085019382010191821161026157602001915b8183106102f25750505090565b82516001600160a01b0381168103610261578152602092830192016102e5565b80518210156103265760209160051b010190565b634e487b7160e01b5f52603260045260245ffdfe608080604052600436101561001c575b50361561001a575f80fd5b005b5f3560e01c908162bf26f414610dc0575080630d2a95ef14610da557806316c38b3c14610d325780631a912f3e14610cf857806320606b7014610cbe5780633644e51514610c845780633816a29214610c0557806339e5d90b14610b8a578063402372f4146109135780634782f779146108b85780634fe47f701461088e5780635300f841146108515780635c975abb1461082d5780635ec4501a146107f55780635f48f393146107d85780637ecebe00146107a05780638da5cb5b14610779578063952ca92c1461074157806398a2e5e2146106f9578063ab6f75cc146102c4578063b7848f321461028a578063e744092e1461024d578063ecd8dc3a146101b55763f2fde38b1461012f575f61000f565b346101b15760203660031901126101b157610148610e07565b5f54906001600160a01b03821633036101a3576001600160a01b03166001600160a01b03199190911681175f556040519081527f4ffd725fc4a22075e9ec71c59edf9c38cdeb588a91b24fc5b61388c5be41282b90602090a1005b6282b42960e81b5f5260045ffd5b5f80fd5b346101b15760403660031901126101b1576101ce610e07565b6101d6610df8565b5f546001600160a01b031633036101a3576001600160a01b0382165f908152600260205260409020805460ff191660ff831515161790557f4b36b2e66f38ed349bec532105790177f1283bcbc094e6cd48565195d3033c43915b604080516001600160a01b039290921682529115156020820152a1005b346101b15760203660031901126101b1576001600160a01b0361026e610e07565b165f526003602052602060ff60405f2054166040519015158152f35b346101b1575f3660031901126101b15760206040517fa6855bd7ff37d4f4e5358b3d8e9f117419db3ea26a0ef57f6ec20b4d20ea5ba88152f35b346101b15760e03660031901126101b1576102dd610e07565b6102e5610e1d565b9060443567ffffffffffffffff81116101b157610306903690600401610e49565b9060643567ffffffffffffffff81116101b157610327903690600401610e49565b90936084359260a4359560c43567ffffffffffffffff81116101b157610351903690600401610e7a565b9490335f52600260205260ff60405f205416156101a35760ff5f5460a01c166106ea578842116106db5760018060a01b038516998a5f5260016020528760405f2054036106cc576001600160a01b0381165f81815260036020526040902054909a9060ff16156106bd5789156106ae57838a0361069f575f975f5b8581106106605750600654600a810290808204600a149015171561064c57891161063d578c9361041861041d938c888f8b908d8f9a61040a8c611100565b6001600160a01b039b610ede565b611177565b160361062e57885f52600160205260405f20610439815461103f565b9055604051636eb1769f60e11b81526001600160a01b03851660048201523060248201526020816044818c5afa80156105df5786915f916105f9575b50106105ea575f5b87811061051757897fcd8854f8b94bf40c619c2b4883f8c072d82f3b33c0fe2c94cf2c2ef40cc6f5d660a08b8b8b8b8b6040516104f6816104e860208201948742918791605493916bffffffffffffffffffffffff199060601b168352601483015260348201520190565b03601f198101835282610ea8565b519020926040519485526020850152604084015260608301526080820152a2005b6105228189866110dc565b356001600160a01b03811681036101b1576020610582918b6105458587896110dc565b6040516323b872dd60e01b81526001600160a01b03808c1660048301529093166024840152356044830152909283919082905f9082906064820190565b03925af19081156105df575f916105b1575b50156105a25760010161047d565b6312171d8360e31b5f5260045ffd5b6105d2915060203d81116105d8575b6105ca8183610ea8565b81019061104d565b8b610594565b503d6105c0565b6040513d5f823e3d90fd5b6313be252b60e01b5f5260045ffd5b9150506020813d602011610626575b8161061560209383610ea8565b810103126101b1578590518b610475565b3d9150610608565b638baa579f60e01b5f5260045ffd5b63070b5a6f60e21b5f5260045ffd5b634e487b7160e01b5f52601160045260245ffd5b9861066c8a87896110dc565b35156106905761067d8a87896110dc565b35810180911161064c57986001016103cc565b631f2a200560e01b5f5260045ffd5b63512509d360e11b5f5260045ffd5b632a67cf2360e01b5f5260045ffd5b63514e24c360e11b5f5260045ffd5b633ab3447f60e11b5f5260045ffd5b63f87d927160e01b5f5260045ffd5b63ab35696f60e01b5f5260045ffd5b346101b15760c03660031901126101b1576020610739610717610e07565b61071f610e1d565b610727610e33565b9160a435926084359260643592611065565b604051908152f35b346101b15760203660031901126101b1576001600160a01b03610762610e07565b165f526004602052602060405f2054604051908152f35b346101b1575f3660031901126101b1575f546040516001600160a01b039091168152602090f35b346101b15760203660031901126101b1576001600160a01b036107c1610e07565b165f526001602052602060405f2054604051908152f35b346101b1575f3660031901126101b1576020600654604051908152f35b346101b15760203660031901126101b1576001600160a01b03610816610e07565b165f526005602052602060405f2054604051908152f35b346101b1575f3660031901126101b157602060ff5f5460a01c166040519015158152f35b346101b15760203660031901126101b1576001600160a01b03610872610e07565b165f526002602052602060ff60405f2054166040519015158152f35b346101b15760203660031901126101b1575f546001600160a01b031633036101a357600435600655005b346101b15760403660031901126101b1576004356001600160a01b038116908190036101b1575f5460243591906001600160a01b031633036101a3575f808093819382821561090a575bf1156105df57005b506108fc610902565b346101b15760e03660031901126101b15761092c610e07565b610934610e1d565b9061093d610e33565b60a435916084359160643560c43567ffffffffffffffff81116101b157610968903690600401610e7a565b96335f52600260205260ff60405f205416156101a35760ff5f5460a01c166106ea578642116106db5760018060a01b03851696875f5260016020528660405f2054036106cc576001600160a01b0382165f8181526003602052604090205490999060ff16156106bd57841561069057600654851161063d578893610418610a07936109f28a611100565b6001600160a01b03958b9089908b908d611065565b160361062e57845f52600160205260405f20610a23815461103f565b9055604051636eb1769f60e11b81526001600160a01b03841660048201523060248201526020816044818a5afa80156105df5782915f91610b55575b50106105ea576040516323b872dd60e01b81526001600160a01b03848116600483015283166024820152604481018290526020816064815f8b5af19081156105df575f91610b36575b50156105a2577f78e38483f3b0eada4705c70fa5cb855244fc294f9fc64f7321ecbf910f7c08b693608093604051610b0e816104e860208201948642918791605493916bffffffffffffffffffffffff199060601b168352601483015260348201520190565b5190206040805198895260208901939093529187015260608601526001600160a01b031693a3005b610b4f915060203d6020116105d8576105ca8183610ea8565b87610aa8565b9150506020813d602011610b82575b81610b7160209383610ea8565b810103126101b15781905188610a5f565b3d9150610b64565b346101b15760c03660031901126101b157610ba3610e07565b610bab610e1d565b60443567ffffffffffffffff81116101b157610bcb903690600401610e49565b9190926064359267ffffffffffffffff84116101b157602094610bf5610739953690600401610e49565b92909160a4359560843595610ede565b346101b15760403660031901126101b157610c1e610e07565b610c26610df8565b5f546001600160a01b031633036101a3576001600160a01b0382165f908152600360205260409020805460ff191660ff831515161790557fdcb2804db02b95bdd568fd11a31c5577ffdf36538c0f670e92930d9c1e8518ab91610230565b346101b1575f3660031901126101b15760206040517f00000000000000000000000000000000000000000000000000000000000000008152f35b346101b1575f3660031901126101b15760206040517f8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f8152f35b346101b1575f3660031901126101b15760206040517ff1142badb16df46802a945f78040f11cbe2a54512d9db28f5536766b6313d8a38152f35b346101b15760203660031901126101b1576004358015158091036101b1575f546001600160a01b03811633036101a35760ff60a01b191660a082901b60ff60a01b16175f556040519081527f0e2fb031ee032dc02d8011dc50b816eb450cf856abd8261680dac74f72165bd290602090a1005b346101b1575f3660031901126101b157602060405160058152f35b346101b1575f3660031901126101b157807f3f6ee851781dc69de2dab37bfb1cf38d1b0df22162ffba71fef477086f239b2360209252f35b6024359081151582036101b157565b600435906001600160a01b03821682036101b157565b602435906001600160a01b03821682036101b157565b604435906001600160a01b03821682036101b157565b9181601f840112156101b15782359167ffffffffffffffff83116101b1576020808501948460051b0101116101b157565b9181601f840112156101b15782359167ffffffffffffffff83116101b157602083818601950101116101b157565b90601f8019910116810190811067ffffffffffffffff821117610eca57604052565b634e487b7160e01b5f52604160045260245ffd5b9694929593919095604051908160208101938490925f905b80821061100f575050610f12925003601f198101835282610ea8565b519020604051909260208201926001600160fb1b0382116101b15782602091610f4d9360051b8091873781010301601f198101835282610ea8565b519020906040519460208601967fa6855bd7ff37d4f4e5358b3d8e9f117419db3ea26a0ef57f6ec20b4d20ea5ba8885260018060a01b0316604087015260018060a01b03166060860152608085015260a084015260c083015260e082015260e08152610fbb61010082610ea8565b51902060405161190160f01b602082019081527f00000000000000000000000000000000000000000000000000000000000000006022830152604282019290925261100981606281016104e8565b51902090565b9092509083356001600160a01b03811691908290036101b157602081600193829352019401920184929391610ef6565b5f19811461064c5760010190565b908160209103126101b1575180151581036101b15790565b94929093916040519460208601967f3f6ee851781dc69de2dab37bfb1cf38d1b0df22162ffba71fef477086f239b23885260018060a01b0316604087015260018060a01b0316606086015260018060a01b0316608085015260a084015260c083015260e082015260e08152610fbb61010082610ea8565b91908110156110ec5760051b0190565b634e487b7160e01b5f52603260045260245ffd5b6001600160a01b03165f81815260046020526040902054430361115957805f52600560205260405f20611133815461103f565b90555f526005602052600560405f20541161114a57565b63a74c1c5f60e01b5f5260045ffd5b805f5260046020524360405f20555f526005602052600160405f2055565b916041036111d65760408101355f1a601b81106111c4575b602092835f9360ff6080946040519485521682840152803560408401520135606082015282805260015afa156105df575f5190565b601b019060ff821161064c579061118f565b60405162461bcd60e51b815260206004820152600e60248201526d084c2c840e6d2ce40d8cadccee8d60931b6044820152606490fdfea264697066735822122021d307e2d14e1bc751054ad114ba9d6f4a77405a97002698e658c5112fd301c564736f6c63430008220033';

// ─── ABI (only what's needed for deployment verification) ───────────────────
const ABI = [
  {
    "type": "constructor",
    "inputs": [
      { "name": "_relayers", "type": "address[]" },
      { "name": "_tokens",   "type": "address[]"  }
    ]
  },
  {
    "type": "function",
    "name": "nonces",
    "inputs":  [{ "name": "user", "type": "address" }],
    "outputs": [{ "name": "", "type": "uint256" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "owner",
    "inputs": [],
    "outputs": [{ "name": "", "type": "address" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "DOMAIN_SEPARATOR",
    "inputs": [],
    "outputs": [{ "name": "", "type": "bytes32" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "relayers",
    "inputs":  [{ "name": "addr", "type": "address" }],
    "outputs": [{ "name": "", "type": "bool" }],
    "stateMutability": "view"
  },
  {
    "type": "function",
    "name": "allowedTokens",
    "inputs":  [{ "name": "token", "type": "address" }],
    "outputs": [{ "name": "", "type": "bool" }],
    "stateMutability": "view"
  }
];

// ─── Load deployer private key ─────────────────────────────────────────────
function loadDeployerKey() {
  // Priority: env variable > .my-deployer.json > .relayer-key.json
  if (process.env.DEPLOY_PK) {
    console.log('🔑 Using DEPLOY_PK environment variable');
    return process.env.DEPLOY_PK;
  }
  
  const myFile = path.join(__dirname, '.my-deployer.json');
  if (fs.existsSync(myFile)) {
    const data = JSON.parse(fs.readFileSync(myFile, 'utf8'));
    console.log('🔑 Using .my-deployer.json');
    return data.privateKey;
  }
  
  // Instructions
  console.log('\n❌ No deployer key found!\n');
  console.log('Provide your key using ONE of these methods:\n');
  console.log('Method 1 — Environment variable:');
  console.log('  DEPLOY_PK=0xYOUR_PRIVATE_KEY node deploy-with-pk.mjs\n');
  console.log('Method 2 — JSON file:');
  console.log('  echo \'{"privateKey":"0xYOUR_PRIVATE_KEY"}\' > .my-deployer.json');
  console.log('  node deploy-with-pk.mjs\n');
  console.log('⚠️  Make sure your wallet has USDC on Arc Testnet for gas!');
  console.log('   Get test USDC at: https://faucet.circle.com (select Arc Testnet)\n');
  process.exit(1);
}

// ─── Main deploy function ──────────────────────────────────────────────────
async function deploy() {
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║        AgentExecutor Deploy Script — Arc Testnet          ║');
  console.log('║  Chain ID: 5042002  |  RPC: rpc.testnet.arc.network       ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');

  const privateKey = loadDeployerKey();
  const provider   = new ethers.JsonRpcProvider(RPC_URL, { chainId: CHAIN_ID, name: 'arc-testnet' });
  const deployer   = new ethers.Wallet(privateKey, provider);
  
  // Optional: separate relayer address
  // If you want the relayer to be a different wallet, set RELAYER_ADDR env var
  const relayerAddr = process.env.RELAYER_ADDR || deployer.address;
  
  console.log('📋 Configuration:');
  console.log('   Deployer:', deployer.address);
  console.log('   Relayer: ', relayerAddr);
  console.log('   Tokens:  ', [USDC_ADDR, EURC_ADDR].join(', '));
  
  // Check balance
  const bal = await provider.getBalance(deployer.address);
  console.log(`\n💰 Balance: ${ethers.formatUnits(bal, 6)} USDC`);
  
  if (bal === 0n) {
    console.log('\n⚠️  WALLET HAS NO FUNDS!');
    console.log('   Get USDC testnet tokens:');
    console.log('   → https://faucet.circle.com (select "Arc Testnet")');
    console.log('   → https://faucets.chain.link/arc-testnet\n');
    process.exit(1);
  }
  
  if (bal < 10000n) { // < 0.01 USDC
    console.log('⚠️  Low balance! Estimated gas: ~0.005-0.01 USDC');
    console.log('   This might not be enough to deploy.\n');
  }

  // Build constructor args
  const relayers = [relayerAddr];
  const tokens   = [USDC_ADDR, EURC_ADDR];
  
  // ABI encode constructor args
  const iface = new ethers.Interface(ABI);
  const constructorData = iface.encodeDeploy([relayers, tokens]);
  const deployData = BYTECODE + constructorData.slice(2);
  
  console.log(`\n📦 Bytecode size: ${Math.round(BYTECODE.length / 2)} bytes`);
  
  // Estimate gas
  let gasLimit;
  try {
    const estimated = await provider.estimateGas({
      from: deployer.address,
      data: deployData,
    });
    gasLimit = estimated * 130n / 100n;
    console.log(`⛽ Gas estimate: ${estimated.toString()} → using ${gasLimit.toString()} (130%)`);
  } catch (e) {
    gasLimit = 3_000_000n;
    console.log(`⛽ Gas estimate failed (${e.message}), using default: ${gasLimit}`);
  }
  
  // Send deploy transaction
  console.log('\n📤 Sending deployment transaction...');
  const tx = await deployer.sendTransaction({
    data:     deployData,
    gasLimit,
  });
  
  console.log(`   TX hash: ${tx.hash}`);
  console.log(`   Explorer: ${EXPLORER}/tx/${tx.hash}`);
  console.log('\n⏳ Waiting for confirmation...');
  
  const receipt = await tx.wait(1);
  
  if (receipt.status !== 1) {
    console.error('❌ Transaction FAILED on-chain!');
    console.error('   Check explorer:', `${EXPLORER}/tx/${tx.hash}`);
    process.exit(1);
  }
  
  const contractAddress = receipt.contractAddress;
  
  console.log('\n╔══════════════════════════════════════════════════════════╗');
  console.log('║           🎉 CONTRACT DEPLOYED SUCCESSFULLY! 🎉           ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log(`📍 Contract Address: ${contractAddress}`);
  console.log(`🔗 TX Hash:          ${tx.hash}`);
  console.log(`🔍 Block:            ${receipt.blockNumber}`);
  console.log(`⛽ Gas Used:         ${receipt.gasUsed.toString()}`);
  console.log(`🌐 Explorer:         ${EXPLORER}/address/${contractAddress}\n`);
  
  // Verify deployment
  try {
    const contract = new ethers.Contract(contractAddress, ABI, provider);
    const owner = await contract.owner();
    const domSep = await contract.DOMAIN_SEPARATOR();
    const isUSDCAllowed = await contract.allowedTokens(USDC_ADDR);
    const isRelayerOk   = await contract.relayers(relayerAddr);
    
    console.log('✅ Contract verification:');
    console.log(`   owner():              ${owner}`);
    console.log(`   DOMAIN_SEPARATOR():   ${domSep.slice(0, 18)}...`);
    console.log(`   allowedTokens(USDC):  ${isUSDCAllowed}`);
    console.log(`   relayers(relayer):    ${isRelayerOk}`);
  } catch (e) {
    console.log('⚠️  Could not verify contract functions:', e.message);
  }
  
  // Save deployment info
  const deployInfo = {
    contractAddress,
    txHash:        tx.hash,
    blockNumber:   receipt.blockNumber,
    deployerAddr:  deployer.address,
    relayerAddr,
    tokens:        { USDC: USDC_ADDR, EURC: EURC_ADDR },
    chainId:       CHAIN_ID,
    rpc:           RPC_URL,
    explorer:      `${EXPLORER}/address/${contractAddress}`,
    deployedAt:    new Date().toISOString(),
    abi:           ABI,
  };
  
  fs.writeFileSync(
    path.join(__dirname, 'deployment.json'),
    JSON.stringify(deployInfo, null, 2)
  );
  
  console.log('💾 Deployment info saved to: deployment.json\n');
  
  // Next steps
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║                      NEXT STEPS                          ║');
  console.log('╚══════════════════════════════════════════════════════════╝\n');
  console.log('1. 🔐 Set Cloudflare secret (for gasless execution):');
  console.log('   cd /home/user/webapp');
  console.log('   npx wrangler secret put RELAYER_PRIVATE_KEY');
  console.log(`   # Paste your relayer private key\n`);
  console.log('2. 🌐 Activate in the dApp:');
  console.log(`   Open: https://execdaat.pages.dev/static/deploy-agent.html`);
  console.log(`   Enter address: ${contractAddress}`);
  console.log(`   Click "Ativar"\n`);
  console.log('3. 💰 Fund the relayer wallet (for gas sponsorship):');
  console.log(`   Send USDC to: ${relayerAddr}`);
  console.log('   (needed for the relayer to pay gas on behalf of users)\n');
  console.log('4. ✅ Test gasless flow:');
  console.log('   Open ExecDaat → Autonoma tab → type "send 10 USDC to 0x..."');
  console.log('   You should see only ONE wallet popup (approve), then gasless execution.\n');
  
  return deployInfo;
}

// ─── Run ──────────────────────────────────────────────────────────────────────
deploy().catch(err => {
  console.error('\n❌ Deploy failed:', err.message || err);
  if (err.code === 'INSUFFICIENT_FUNDS') {
    console.error('\n💡 Solution: Fund your wallet with USDC on Arc Testnet');
    console.error('   https://faucet.circle.com (select "Arc Testnet")\n');
  }
  process.exit(1);
});
