// ============================================================
// ExecDaat Invariant Tests — Smart Contract Safety Properties
// ============================================================
// Requires: Hardhat test environment
// Run: cd contracts/hardhat && npx hardhat test test/Invariants.test.js
// ============================================================
const { expect } = require('chai');
const { ethers } = require('hardhat');

describe('ArcVault Invariants', function () {
  let vault, usdc, owner, operator, user;

  before(async function () {
    [owner, operator, user] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory('MockERC20Permit');
    usdc = await MockUSDC.deploy('USD Coin', 'USDC');
    await usdc.waitForDeployment();

    const ArcVault = await ethers.getContractFactory('ArcVault');
    vault = await ArcVault.deploy(owner.address, [operator.address], [await usdc.getAddress()], ['USDC']);
    await vault.waitForDeployment();
  });

  // Invariant 1: Total accounting remains consistent
  it('INVARIANT: availableLiquidity <= rawBalance', async function () {
    await usdc.mint(owner.address, ethers.parseUnits('1000', 6));
    await usdc.connect(owner).approve(await vault.getAddress(), ethers.parseUnits('1000', 6));
    await vault.connect(owner).deposit(await usdc.getAddress(), ethers.parseUnits('100', 6));

    const raw = await vault.rawBalance(await usdc.getAddress());
    const avail = await vault.getAvailableLiquidity(await usdc.getAddress());
    expect(avail).to.be.lte(raw);
  });

  // Invariant 2: Cannot withdraw more than available
  it('INVARIANT: withdraw respects available liquidity', async function () {
    await usdc.mint(owner.address, ethers.parseUnits('1000', 6));
    await usdc.connect(owner).approve(await vault.getAddress(), ethers.parseUnits('1000', 6));

    const avail = await vault.getAvailableLiquidity(await usdc.getAddress());
    await expect(
      vault.connect(owner).withdraw(await usdc.getAddress(), avail + 1n, owner.address)
    ).to.be.revertedWith('exceeds available');
  });

  // Invariant 3: Unauthorized users cannot settle
  it('INVARIANT: non-operator cannot reserve', async function () {
    await expect(
      vault.connect(user).reserve(ethers.id('test'), await usdc.getAddress(), 100n)
    ).to.be.revertedWith('not operator');
  });

  // Invariant 4: Paused vault blocks deposits
  it('INVARIANT: paused vault blocks operations', async function () {
    await vault.connect(operator).emergencyPause();
    expect(await vault.paused()).to.be.true;

    await expect(
      vault.connect(owner).deposit(await usdc.getAddress(), 100n)
    ).to.be.revertedWith('paused');

    await vault.connect(owner).unpause();
    expect(await vault.paused()).to.be.false;
  });
});

describe('ArcTreasury Invariants', function () {
  let treasury, signer1, signer2, signer3, nonSigner;

  before(async function () {
    [signer1, signer2, signer3, nonSigner] = await ethers.getSigners();
    const ArcTreasury = await ethers.getContractFactory('ArcTreasury');
    treasury = await ArcTreasury.deploy([signer1.address, signer2.address, signer3.address], 2);
    await treasury.waitForDeployment();
  });

  // Invariant 1: Only approved governance actions execute
  it('INVARIANT: proposal below threshold cannot execute', async function () {
    const tx = await treasury.connect(signer1).submitProposal(
      signer1.address, 0, '0x', 'Test'
    );
    await tx.wait();
    // signer1 auto-approves (1 approval), threshold is 2
    await expect(
      treasury.connect(signer1).executeProposal(0)
    ).to.be.revertedWith('threshold not met');
  });

  // Invariant 2: Non-signer cannot submit
  it('INVARIANT: non-signer cannot submit proposal', async function () {
    await expect(
      treasury.connect(nonSigner).submitProposal(signer1.address, 0, '0x', 'Test')
    ).to.be.revertedWith('not signer');
  });

  // Invariant 3: Admin changes require proposal
  it('INVARIANT: admin functions guarded by onlySelf', async function () {
    await expect(
      treasury.connect(signer1).addSigner(nonSigner.address)
    ).to.be.revertedWith('only via proposal');
  });
});

describe('SimpleAMM Invariants', function () {
  let amm, eurc, usdc, lp, trader;

  before(async function () {
    [lp, trader] = await ethers.getSigners();
    const MockERC20 = await ethers.getContractFactory('MockERC20Permit');
    eurc = await MockERC20.deploy('Euro Coin', 'EURC');
    usdc = await MockERC20.deploy('USD Coin', 'USDC');
    await eurc.waitForDeployment();
    await usdc.waitForDeployment();

    const SimpleAMM = await ethers.getContractFactory('SimpleAMM');
    amm = await SimpleAMM.deploy(await eurc.getAddress(), await usdc.getAddress());
    await amm.waitForDeployment();
  });

  // Invariant 1: k = x * y is preserved (approximately, within fee)
  it('INVARIANT: constant product preserved after swap', async function () {
    // Add initial liquidity
    await eurc.mint(lp.address, ethers.parseUnits('100000', 6));
    await usdc.mint(lp.address, ethers.parseUnits('100000', 6));
    await eurc.connect(lp).approve(await amm.getAddress(), ethers.parseUnits('100000', 6));
    await usdc.connect(lp).approve(await amm.getAddress(), ethers.parseUnits('100000', 6));
    await amm.connect(lp).addLiquidity(ethers.parseUnits('10000', 6), ethers.parseUnits('10000', 6));

    const [rA, rB] = await amm.getReserves();
    const kBefore = rA * rB;

    // Execute swap
    await eurc.mint(trader.address, ethers.parseUnits('1000', 6));
    await eurc.connect(trader).approve(await amm.getAddress(), ethers.parseUnits('1000', 6));
    await amm.connect(trader).swapAforB(ethers.parseUnits('100', 6), 0);

    const [rA2, rB2] = await amm.getReserves();
    const kAfter = rA2 * rB2;

    // k should increase (fees added to pool) or stay the same
    expect(kAfter).to.be.gte(kBefore);
  });

  // Invariant 2: Slippage protection works
  it('INVARIANT: slippage guard prevents unfavorable swaps', async function () {
    await eurc.mint(trader.address, ethers.parseUnits('1000', 6));
    await eurc.connect(trader).approve(await amm.getAddress(), ethers.parseUnits('1000', 6));

    // Request way more than possible
    await expect(
      amm.connect(trader).swapAforB(ethers.parseUnits('1', 6), ethers.parseUnits('1000000', 6))
    ).to.be.revertedWith('Slippage exceeded');
  });
});

describe('OTCEscrow Invariants', function () {
  let escrow, usdc, arbiter, buyer, seller;

  before(async function () {
    [arbiter, buyer, seller] = await ethers.getSigners();
    const MockUSDC = await ethers.getContractFactory('MockERC20Permit');
    usdc = await MockUSDC.deploy('USD Coin', 'USDC');
    await usdc.waitForDeployment();
    await usdc.mint(buyer.address, ethers.parseUnits('100000', 6));

    const OTCEscrow = await ethers.getContractFactory('OTCEscrow');
    escrow = await OTCEscrow.deploy(arbiter.address, []);
    await escrow.waitForDeployment();
  });

  // Invariant 1: State machine prevents invalid transitions
  it('INVARIANT: cannot fund unsigned deal', async function () {
    const id = ethers.id('deal-' + Date.now());
    // Create deal but don't sign
    await escrow.connect(buyer).createDeal(
      seller.address,
      await usdc.getAddress(),
      ethers.parseUnits('100', 6),
      Math.floor(Date.now() / 1000) + 3600,
      ethers.id('doc')
    );

    await expect(
      escrow.connect(buyer).fundDeal(id)
    ).to.be.revertedWith('NotSigned');
  });

  // Invariant 2: Only parties can interact
  it('INVARIANT: non-party cannot sign', async function () {
    await usdc.connect(buyer).approve(await escrow.getAddress(), ethers.parseUnits('100', 6));
    const tx = await escrow.connect(buyer).createDeal(
      seller.address,
      await usdc.getAddress(),
      ethers.parseUnits('100', 6),
      Math.floor(Date.now() / 1000) + 3600,
      ethers.id('doc')
    );
    const receipt = await tx.wait();
    // Find deal ID from event
    const event = receipt.logs.find(l => {
      try { const p = escrow.interface.parseLog(l); return p.name === 'DealCreated'; } catch { return false; }
    });
    const dealId = escrow.interface.parseLog(event).args.dealId;

    await expect(
      escrow.connect(arbiter).signDeal(dealId)
    ).to.be.revertedWith('NotParty');
  });
});
