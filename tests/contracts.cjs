// ============================================================
// ExecDaat Contract Unit Tests — Deployment + Access Control
// ============================================================
// Uses Hardhat test environment (npx hardhat test)
// ============================================================
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('ContractFactory', function () {
  let factory, usdc, owner, contractor, client;

  before(async function () {
    [owner, contractor, client] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory('MockERC20Permit');
    usdc = await MockUSDC.deploy('USD Coin', 'USDC');
    await usdc.waitForDeployment();

    // Mint 1M USDC to client for testing
    await usdc.mint(client.address, ethers.parseUnits('1000000', 6));
  });

  it('deploys successfully', async function () {
    const Factory = await ethers.getContractFactory('ContractFactory');
    factory = await Factory.deploy(await usdc.getAddress());
    await factory.waitForDeployment();
    expect(await factory.getAddress()).to.be.properAddress;
  });

  it('creates a contract with milestones', async function () {
    await usdc.connect(client).approve(await factory.getAddress(), ethers.parseUnits('1000', 6));

    const tx = await factory.connect(client).createContract(
      contractor.address,
      'Test Project',
      ethers.parseUnits('1000', 6),
      ['Design', 'Development', 'Review'],
      [ethers.parseUnits('300', 6), ethers.parseUnits('500', 6), ethers.parseUnits('200', 6)]
    );
    await tx.wait();

    const contract = await factory.getContract(1);
    expect(contract.client).to.equal(client.address);
    expect(contract.contractor).to.equal(contractor.address);
    expect(contract.status).to.equal(0); // Draft
  });

  it('contractor can sign contract', async function () {
    await factory.connect(contractor).signContract(1);
    const contract = await factory.getContract(1);
    expect(contract.status).to.equal(1); // Active
  });

  it('refuses duplicate signing', async function () {
    await expect(factory.connect(contractor).signContract(1)).to.be.reverted;
  });
});

describe('OTCEscrow', function () {
  let escrow, usdc, arbiter, buyer, seller;

  before(async function () {
    [arbiter, buyer, seller] = await ethers.getSigners();

    const MockUSDC = await ethers.getContractFactory('MockERC20Permit');
    usdc = await MockUSDC.deploy('USD Coin', 'USDC');
    await usdc.waitForDeployment();
    await usdc.mint(buyer.address, ethers.parseUnits('1000000', 6));
  });

  it('deploys with arbiter', async function () {
    const OTCEscrow = await ethers.getContractFactory('OTCEscrow');
    escrow = await OTCEscrow.deploy(arbiter.address, []);
    await escrow.waitForDeployment();
    expect(await escrow.getAddress()).to.be.properAddress;
    expect(await escrow.arbiter()).to.equal(arbiter.address);
  });

  it('creates a deal', async function () {
    const dealTx = await escrow.connect(buyer).createDeal(
      seller.address,
      await usdc.getAddress(),
      ethers.parseUnits('100', 6),
      Math.floor(Date.now() / 1000) + 3600,
      ethers.id('contract-doc')
    );
    await dealTx.wait();
  });
});
