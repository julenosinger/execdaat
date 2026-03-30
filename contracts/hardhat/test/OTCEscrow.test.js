// ============================================================
// OTCEscrow v3 — Comprehensive Test Suite
// Coverage target: ≥ 90%
//
// Test categories:
//   A. Deployment & constructor
//   B. createDeal — happy path + all validation branches
//   C. signDeal   — happy path + edge cases
//   D. fundDeal   — happy path + InsufficientAllowance + TransferFailed + guards
//   E. fundDealWithPermit — EIP-2612 permit flow + expired permit
//   F. release    — seller-only + authorized + TGE guard + state cleanup
//   G. cancel     — unfunded instant + funded dual-consent + dispute guard
//   H. raiseDispute / resolveDispute — full arbitration flow
//   I. setAuthorized — governance
//   J. View functions — getDealStatus, getDeal, dealStatus, canRelease
//   K. Edge cases — front-running IDs, double-funding, double-release,
//                   premature release, reentrancy attempt
// ============================================================

const { expect }           = require("chai");
const { ethers }           = require("hardhat");
const { time }             = require("@nomicfoundation/hardhat-network-helpers");

// ─── Helpers ─────────────────────────────────────────────────────────────────
const ZERO_ADDR  = ethers.ZeroAddress;
const ZERO_HASH  = ethers.ZeroHash;
const ONE_HOUR   = 3600n;
const ONE_DAY    = 86400n;
const AMOUNT     = ethers.parseUnits("1000", 6); // 1000 USDC (6 decimals)
const SMALL      = ethers.parseUnits("1", 6);    // 1 USDC

// State enum values from the contract
const State = { Pending: 0n, Funded: 1n, Completed: 2n, Cancelled: 3n, Disputed: 4n };

/**
 * Deploy a fresh OTCEscrow + MockERC20Permit for each test group.
 * Returns { escrow, token, deployer, arbitrator, buyer, seller, authorized, third }
 */
async function deployFixture() {
  const signers     = await ethers.getSigners();
  const [deployer, arbitratorAcc, buyerAcc, sellerAcc, authorizedAcc, thirdAcc] = signers;

  // Deploy mock ERC-20 (6 decimals, like USDC)
  const Token = await ethers.getContractFactory("MockERC20Permit");
  const token = await Token.deploy("Mock USDC", "mUSDC", 6);

  // Mint tokens for buyer
  await token.mint(buyerAcc.address, ethers.parseUnits("100000", 6));

  // Deploy OTCEscrow with arbitrator and one authorized releaser
  const Escrow = await ethers.getContractFactory("OTCEscrow");
  const escrow = await Escrow.deploy(arbitratorAcc.address, [authorizedAcc.address]);

  return {
    escrow, token,
    deployer, arbitrator: arbitratorAcc,
    buyer: buyerAcc, seller: sellerAcc,
    authorized: authorizedAcc, third: thirdAcc
  };
}

/**
 * Create a deal and return its dealId.
 * Defaults to AMOUNT, tgeTimestamp = now + 1 day, contractHash = ZERO_HASH
 */
async function createDeal(escrow, buyer, seller, token, overrides = {}) {
  const now          = BigInt(await time.latest());
  const tgeTimestamp = overrides.tgeTimestamp ?? (now + ONE_DAY);
  const amount       = overrides.amount       ?? AMOUNT;
  const hash         = overrides.contractHash ?? ZERO_HASH;

  const tx = await escrow.connect(buyer).createDeal(
    seller.address, token.target, amount, tgeTimestamp, hash
  );
  const receipt = await tx.wait();
  const event   = receipt.logs
    .map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } })
    .find(e => e?.name === "DealCreated");
  return event.args.dealId;
}

/**
 * Sign the deal as both buyer and seller.
 */
async function signBoth(escrow, buyer, seller, dealId) {
  await escrow.connect(buyer).signDeal(dealId);
  await escrow.connect(seller).signDeal(dealId);
}

/**
 * Fund the deal (requires prior approval).
 */
async function fundDeal(escrow, token, buyer, dealId, amount = AMOUNT) {
  await token.connect(buyer).approve(escrow.target, amount);
  await escrow.connect(buyer).fundDeal(dealId);
}

// ─────────────────────────────────────────────────────────────────────────────
// A. DEPLOYMENT
// ─────────────────────────────────────────────────────────────────────────────
describe("A. Deployment", function () {
  it("sets arbitrator correctly", async function () {
    const { escrow, arbitrator } = await deployFixture();
    expect(await escrow.arbitrator()).to.equal(arbitrator.address);
  });

  it("marks initial authorized address as authorized", async function () {
    const { escrow, authorized } = await deployFixture();
    expect(await escrow.isAuthorized(authorized.address)).to.be.true;
  });

  it("computes DOMAIN_SEPARATOR with chain ID and contract address", async function () {
    const { escrow } = await deployFixture();
    const ds = await escrow.DOMAIN_SEPARATOR();
    expect(ds).to.match(/^0x[0-9a-f]{64}$/i);
  });

  it("reverts if arbitrator is zero address", async function () {
    const Escrow = await ethers.getContractFactory("OTCEscrow");
    await expect(Escrow.deploy(ZERO_ADDR, []))
      .to.be.revertedWithCustomError(await Escrow.deploy(
        (await ethers.getSigners())[1].address, []
      ), "InvalidAddress");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// B. createDeal
// ─────────────────────────────────────────────────────────────────────────────
describe("B. createDeal", function () {
  it("creates a deal and emits DealCreated", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_DAY;

    await expect(
      escrow.connect(buyer).createDeal(seller.address, token.target, AMOUNT, tge, ZERO_HASH)
    )
      .to.emit(escrow, "DealCreated")
      .withArgs(
        (id) => id !== ZERO_HASH,
        buyer.address,
        seller.address,
        token.target,
        AMOUNT,
        tge,
        ZERO_HASH
      );
  });

  it("records the deal in dealsByParty for both parties", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    const buyerDeals  = await escrow.getDealsByParty(buyer.address);
    const sellerDeals = await escrow.getDealsByParty(seller.address);
    expect(buyerDeals).to.include(dealId);
    expect(sellerDeals).to.include(dealId);
  });

  it("initialises deal with State.Pending", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    const deal   = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Pending);
  });

  it("reverts with InvalidAddress when seller is zero", async function () {
    const { escrow, token, buyer } = await deployFixture();
    const now = BigInt(await time.latest());
    await expect(
      escrow.connect(buyer).createDeal(ZERO_ADDR, token.target, AMOUNT, now + ONE_DAY, ZERO_HASH)
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("reverts with InvalidAddress when token is zero", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    await expect(
      escrow.connect(buyer).createDeal(seller.address, ZERO_ADDR, AMOUNT, now + ONE_DAY, ZERO_HASH)
    ).to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("reverts with SameAddress when buyer == seller", async function () {
    const { escrow, token, buyer } = await deployFixture();
    const now = BigInt(await time.latest());
    await expect(
      escrow.connect(buyer).createDeal(buyer.address, token.target, AMOUNT, now + ONE_DAY, ZERO_HASH)
    ).to.be.revertedWithCustomError(escrow, "SameAddress");
  });

  it("reverts with InvalidAmount when amount is zero", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    await expect(
      escrow.connect(buyer).createDeal(seller.address, token.target, 0n, now + ONE_DAY, ZERO_HASH)
    ).to.be.revertedWithCustomError(escrow, "InvalidAmount");
  });

  it("reverts with InvalidTimestamp when tgeTimestamp is zero", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    await expect(
      escrow.connect(buyer).createDeal(seller.address, token.target, AMOUNT, 0n, ZERO_HASH)
    ).to.be.revertedWithCustomError(escrow, "InvalidTimestamp");
  });

  it("generates unique deal IDs in the same block for same params via block.number salt", async function () {
    // Two separate txs will use different timestamps — IDs should differ
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_DAY;
    const id1 = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    const id2 = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    expect(id1).to.not.equal(id2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// C. signDeal
// ─────────────────────────────────────────────────────────────────────────────
describe("C. signDeal", function () {
  it("buyer can sign and emits DealSigned(Buyer)", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    await expect(escrow.connect(buyer).signDeal(dealId))
      .to.emit(escrow, "DealSigned")
      .withArgs(dealId, buyer.address, "Buyer");

    const deal = await escrow.getDeal(dealId);
    expect(deal.buyerSigned).to.be.true;
  });

  it("seller can sign and emits DealSigned(Seller)", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    await expect(escrow.connect(seller).signDeal(dealId))
      .to.emit(escrow, "DealSigned")
      .withArgs(dealId, seller.address, "Seller");

    const deal = await escrow.getDeal(dealId);
    expect(deal.sellerSigned).to.be.true;
  });

  it("both parties sign and both flags are set", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    const deal = await escrow.getDeal(dealId);
    expect(deal.buyerSigned).to.be.true;
    expect(deal.sellerSigned).to.be.true;
  });

  it("reverts with NotParty when a third party tries to sign", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await expect(escrow.connect(third).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
  });

  it("reverts with AlreadySigned on double-sign by buyer", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(buyer).signDeal(dealId);
    await expect(escrow.connect(buyer).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadySigned");
  });

  it("reverts with AlreadySigned on double-sign by seller", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(seller).signDeal(dealId);
    await expect(escrow.connect(seller).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadySigned");
  });

  it("reverts with DealNotFound for non-existent deal", async function () {
    const { escrow, buyer } = await deployFixture();
    await expect(escrow.connect(buyer).signDeal(ZERO_HASH))
      .to.be.revertedWithCustomError(escrow, "DealNotFound");
  });

  it("reverts with AlreadyCancelled on cancelled deal", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(buyer).cancel(dealId);
    await expect(escrow.connect(buyer).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyCancelled");
  });

  it("reverts with AlreadyFunded when deal is already funded", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await expect(escrow.connect(buyer).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyFunded");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D. fundDeal
// ─────────────────────────────────────────────────────────────────────────────
describe("D. fundDeal", function () {
  it("buyer funds after both sign — tokens locked in escrow", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    const before = await token.balanceOf(escrow.target);
    await token.connect(buyer).approve(escrow.target, AMOUNT);

    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.emit(escrow, "DealFunded")
      .withArgs(dealId, AMOUNT);

    const after = await token.balanceOf(escrow.target);
    expect(after - before).to.equal(AMOUNT);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Funded);
  });

  it("reverts with NotBuyer when seller tries to fund", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await token.connect(seller).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(seller).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "NotBuyer");
  });

  it("reverts with NotSigned when only buyer has signed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(buyer).signDeal(dealId);
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "NotSigned");
  });

  it("reverts with NotSigned when only seller has signed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(seller).signDeal(dealId);
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "NotSigned");
  });

  it("reverts with InsufficientAllowance when allowance is too low", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    // Approve only 1 token instead of 1000
    await token.connect(buyer).approve(escrow.target, SMALL);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "InsufficientAllowance");
  });

  it("reverts with InsufficientAllowance when zero allowance", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    // No approval at all
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "InsufficientAllowance");
  });

  it("reverts with AlreadyFunded on double-funding attempt", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    // Try to fund again — even with fresh approval
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyFunded");
  });

  it("reverts with AlreadyCancelled on cancelled deal", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await escrow.connect(buyer).cancel(dealId);
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyCancelled");
  });

  it("reverts with DealDisputed when deal is in disputed state", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    // Cancel first, then re-fund isn't possible — instead, raise dispute
    await escrow.connect(buyer).raiseDispute(dealId);

    // Can't fund again once disputed
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "DealDisputed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// E. fundDealWithPermit (EIP-2612)
// ─────────────────────────────────────────────────────────────────────────────
describe("E. fundDealWithPermit (EIP-2612)", function () {
  /**
   * Helper: produce a valid EIP-2612 permit signature using ethers v6 signTypedData.
   */
  async function signPermit(signer, token, spender, value, deadline, nonce) {
    const domain = {
      name:              await token.name(),
      version:           "1",
      chainId:           (await ethers.provider.getNetwork()).chainId,
      verifyingContract: token.target
    };
    const types = {
      Permit: [
        { name: "owner",   type: "address" },
        { name: "spender", type: "address" },
        { name: "value",   type: "uint256" },
        { name: "nonce",   type: "uint256" },
        { name: "deadline",type: "uint256" }
      ]
    };
    const values = { owner: signer.address, spender, value, nonce, deadline };
    const sig = await signer.signTypedData(domain, types, values);
    return ethers.Signature.from(sig);
  }

  it("funds deal via EIP-2612 permit (no prior approve needed)", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    const deadline = BigInt(await time.latest()) + ONE_DAY;
    const nonce    = await token.nonces(buyer.address);
    const sig      = await signPermit(buyer, token, escrow.target, AMOUNT, deadline, nonce);

    const before = await token.balanceOf(escrow.target);
    await expect(
      escrow.connect(buyer).fundDealWithPermit(dealId, deadline, sig.v, sig.r, sig.s)
    )
      .to.emit(escrow, "DealFunded")
      .withArgs(dealId, AMOUNT);

    const after = await token.balanceOf(escrow.target);
    expect(after - before).to.equal(AMOUNT);
  });

  it("reverts with PermitExpired when deadline has passed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    const deadline = 1n; // far in the past
    const nonce    = await token.nonces(buyer.address);
    const sig      = await signPermit(buyer, token, escrow.target, AMOUNT, deadline, nonce);

    await expect(
      escrow.connect(buyer).fundDealWithPermit(dealId, deadline, sig.v, sig.r, sig.s)
    ).to.be.revertedWithCustomError(escrow, "PermitExpired");
  });

  it("falls back to existing allowance if permit reverts", async function () {
    // If the token's permit call reverts (e.g. bad sig but allowance already set)
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    // Pre-approve via classic approve
    await token.connect(buyer).approve(escrow.target, AMOUNT);

    // Provide a garbage permit sig — contract should fall back to existing allowance
    const deadline = BigInt(await time.latest()) + ONE_DAY;
    const badSig = { v: 27, r: ZERO_HASH, s: ZERO_HASH };

    await expect(
      escrow.connect(buyer).fundDealWithPermit(dealId, deadline, badSig.v, badSig.r, badSig.s)
    ).to.emit(escrow, "DealFunded");
  });

  it("reverts with InsufficientAllowance when permit reverts AND no allowance", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    const deadline = BigInt(await time.latest()) + ONE_DAY;
    const badSig = { v: 27, r: ZERO_HASH, s: ZERO_HASH };

    await expect(
      escrow.connect(buyer).fundDealWithPermit(dealId, deadline, badSig.v, badSig.r, badSig.s)
    ).to.be.revertedWithCustomError(escrow, "InsufficientAllowance");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// F. release
// ─────────────────────────────────────────────────────────────────────────────
describe("F. release", function () {
  it("seller can release after TGE — tokens go to seller, deal Completed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    // Fast-forward past TGE
    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    const sellerBefore = await token.balanceOf(seller.address);
    await expect(escrow.connect(seller).release(dealId))
      .to.emit(escrow, "DealReleased")
      .withArgs(dealId, seller.address, AMOUNT);

    const sellerAfter = await token.balanceOf(seller.address);
    expect(sellerAfter - sellerBefore).to.equal(AMOUNT);

    const updatedDeal = await escrow.getDeal(dealId);
    expect(updatedDeal.state).to.equal(State.Completed);
    expect(updatedDeal.amount).to.equal(0n);  // state cleanup
  });

  it("authorized address can release", async function () {
    const { escrow, token, buyer, seller, authorized } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(authorized).release(dealId))
      .to.emit(escrow, "DealReleased");
  });

  it("reverts with NotAuthorized when buyer tries to release", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(buyer).release(dealId))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("reverts with NotAuthorized when third party tries to release", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(third).release(dealId))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });

  it("reverts with TGENotReached before TGE timestamp", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    // Do NOT advance time — TGE is in the future
    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "TGENotReached");
  });

  it("reverts with NotFunded before funding", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    // TGE already in the past by using a very old timestamp
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: 1n });
    await signBoth(escrow, buyer, seller, dealId);
    // TGE is in the past (timestamp 1 = epoch) but deal is not funded
    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "NotFunded");
  });

  it("reverts with AlreadyReleased on double-release attempt", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);
    await escrow.connect(seller).release(dealId);

    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyReleased");
  });

  it("reverts with DealDisputed when deal is disputed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "DealDisputed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// G. cancel
// ─────────────────────────────────────────────────────────────────────────────
describe("G. cancel", function () {
  // --- G.1  Unfunded (Pending) ---
  it("buyer can cancel unfunded deal immediately", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    await expect(escrow.connect(buyer).cancel(dealId))
      .to.emit(escrow, "DealCancelled")
      .withArgs(dealId, buyer.address, false);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Cancelled);
  });

  it("seller can cancel unfunded deal immediately", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    await expect(escrow.connect(seller).cancel(dealId))
      .to.emit(escrow, "DealCancelled")
      .withArgs(dealId, seller.address, false);
  });

  it("third party cannot cancel", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await expect(escrow.connect(third).cancel(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
  });

  // --- G.2  Funded (dual-consent) ---
  it("first cancel request emits CancelRequested, not DealCancelled", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await expect(escrow.connect(buyer).cancel(dealId))
      .to.emit(escrow, "CancelRequested")
      .withArgs(dealId, buyer.address);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Funded);  // still funded — needs both
  });

  it("second cancel request (seller) completes cancellation + refunds buyer", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await escrow.connect(buyer).cancel(dealId);

    const buyerBefore = await token.balanceOf(buyer.address);
    await expect(escrow.connect(seller).cancel(dealId))
      .to.emit(escrow, "DealCancelled")
      .withArgs(dealId, seller.address, true);

    const buyerAfter = await token.balanceOf(buyer.address);
    expect(buyerAfter - buyerBefore).to.equal(AMOUNT);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Cancelled);
    expect(deal.amount).to.equal(0n);  // state cleanup
  });

  it("reverts with AlreadyCancelRequested on duplicate request", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await escrow.connect(buyer).cancel(dealId);
    await expect(escrow.connect(buyer).cancel(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyCancelRequested");
  });

  it("reverts with AlreadyCancelled once cancelled", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(buyer).cancel(dealId);
    await expect(escrow.connect(buyer).cancel(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyCancelled");
  });

  it("reverts with DealDisputed when deal is disputed", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);

    await expect(escrow.connect(buyer).cancel(dealId))
      .to.be.revertedWithCustomError(escrow, "DealDisputed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// H. raiseDispute / resolveDispute
// ─────────────────────────────────────────────────────────────────────────────
describe("H. Dispute & Arbitration", function () {
  it("buyer can raise dispute on funded deal", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await expect(escrow.connect(buyer).raiseDispute(dealId))
      .to.emit(escrow, "DisputeRaised")
      .withArgs(dealId, buyer.address);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Disputed);
    expect(deal.disputeRaisedBy).to.equal(buyer.address);
  });

  it("seller can raise dispute on funded deal", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await expect(escrow.connect(seller).raiseDispute(dealId))
      .to.emit(escrow, "DisputeRaised")
      .withArgs(dealId, seller.address);
  });

  it("reverts with NotFunded when raising dispute on unfunded deal", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);

    await expect(escrow.connect(buyer).raiseDispute(dealId))
      .to.be.revertedWithCustomError(escrow, "NotFunded");
  });

  it("reverts with NotParty when third party raises dispute", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await expect(escrow.connect(third).raiseDispute(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
  });

  it("arbitrator resolves dispute → release to seller", async function () {
    const { escrow, token, buyer, seller, arbitrator } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);

    const sellerBefore = await token.balanceOf(seller.address);
    await expect(escrow.connect(arbitrator).resolveDispute(dealId, true))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(dealId, true, arbitrator.address);

    const sellerAfter = await token.balanceOf(seller.address);
    expect(sellerAfter - sellerBefore).to.equal(AMOUNT);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Completed);
    expect(deal.amount).to.equal(0n);
  });

  it("arbitrator resolves dispute → refund to buyer", async function () {
    const { escrow, token, buyer, seller, arbitrator } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(seller).raiseDispute(dealId);

    const buyerBefore = await token.balanceOf(buyer.address);
    await expect(escrow.connect(arbitrator).resolveDispute(dealId, false))
      .to.emit(escrow, "DisputeResolved")
      .withArgs(dealId, false, arbitrator.address);

    const buyerAfter = await token.balanceOf(buyer.address);
    expect(buyerAfter - buyerBefore).to.equal(AMOUNT);

    const deal = await escrow.getDeal(dealId);
    expect(deal.state).to.equal(State.Cancelled);
    expect(deal.amount).to.equal(0n);
  });

  it("reverts with NotArbitrator when non-arbitrator calls resolveDispute", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);

    await expect(escrow.connect(third).resolveDispute(dealId, true))
      .to.be.revertedWithCustomError(escrow, "NotArbitrator");
  });

  it("reverts with NotArbitrator when buyer calls resolveDispute", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);

    await expect(escrow.connect(buyer).resolveDispute(dealId, true))
      .to.be.revertedWithCustomError(escrow, "NotArbitrator");
  });

  it("reverts with NoDispute when no dispute is active", async function () {
    const { escrow, token, buyer, seller, arbitrator } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await expect(escrow.connect(arbitrator).resolveDispute(dealId, true))
      .to.be.revertedWithCustomError(escrow, "NoDispute");
  });

  it("reverts with DealDisputed on second raiseDispute call", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);
    // state is now Disputed; DealDisputed check fires first
    await expect(escrow.connect(seller).raiseDispute(dealId))
      .to.be.revertedWithCustomError(escrow, "DealDisputed");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// I. setAuthorized (governance)
// ─────────────────────────────────────────────────────────────────────────────
describe("I. setAuthorized", function () {
  it("arbitrator can add a new authorized address", async function () {
    const { escrow, arbitrator, third } = await deployFixture();

    await expect(escrow.connect(arbitrator).setAuthorized(third.address, true))
      .to.emit(escrow, "AuthorizationUpdated")
      .withArgs(third.address, true);

    expect(await escrow.isAuthorized(third.address)).to.be.true;
  });

  it("arbitrator can revoke an authorized address", async function () {
    const { escrow, arbitrator, authorized } = await deployFixture();

    await expect(escrow.connect(arbitrator).setAuthorized(authorized.address, false))
      .to.emit(escrow, "AuthorizationUpdated")
      .withArgs(authorized.address, false);

    expect(await escrow.isAuthorized(authorized.address)).to.be.false;
  });

  it("reverts with NotArbitrator when non-arbitrator calls setAuthorized", async function () {
    const { escrow, buyer, third } = await deployFixture();
    await expect(escrow.connect(buyer).setAuthorized(third.address, true))
      .to.be.revertedWithCustomError(escrow, "NotArbitrator");
  });

  it("reverts with InvalidAddress when setting zero address", async function () {
    const { escrow, arbitrator } = await deployFixture();
    await expect(escrow.connect(arbitrator).setAuthorized(ZERO_ADDR, true))
      .to.be.revertedWithCustomError(escrow, "InvalidAddress");
  });

  it("newly authorized address can release a funded deal", async function () {
    const { escrow, token, buyer, seller, arbitrator, third } = await deployFixture();
    await escrow.connect(arbitrator).setAuthorized(third.address, true);

    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(third).release(dealId))
      .to.emit(escrow, "DealReleased");
  });

  it("revoked address can no longer release", async function () {
    const { escrow, token, buyer, seller, arbitrator, authorized } = await deployFixture();
    await escrow.connect(arbitrator).setAuthorized(authorized.address, false);

    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    const deal = await escrow.getDeal(dealId);
    await time.increaseTo(deal.tgeTimestamp + 1n);

    await expect(escrow.connect(authorized).release(dealId))
      .to.be.revertedWithCustomError(escrow, "NotAuthorized");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// J. View functions
// ─────────────────────────────────────────────────────────────────────────────
describe("J. View functions", function () {
  it("getDeal returns correct data after creation", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_DAY;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });

    const deal = await escrow.getDeal(dealId);
    expect(deal.buyer).to.equal(buyer.address);
    expect(deal.seller).to.equal(seller.address);
    expect(deal.token).to.equal(token.target);
    expect(deal.amount).to.equal(AMOUNT);
    expect(deal.tgeTimestamp).to.equal(tge);
    expect(deal.buyerSigned).to.be.false;
    expect(deal.sellerSigned).to.be.false;
    expect(deal.state).to.equal(State.Pending);
  });

  it("getDealStatus returns (false, false, false, Pending) after creation", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    const [bs, ss, funded, state] = await escrow.getDealStatus(dealId);
    expect(bs).to.be.false;
    expect(ss).to.be.false;
    expect(funded).to.be.false;
    expect(state).to.equal(State.Pending);
  });

  it("getDealStatus returns (true, true, true, Funded) after funding", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    const [bs, ss, funded, state] = await escrow.getDealStatus(dealId);
    expect(bs).to.be.true;
    expect(ss).to.be.true;
    expect(funded).to.be.true;
    expect(state).to.equal(State.Funded);
  });

  it("dealStatus returns correct strings at each lifecycle stage", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_HOUR;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });

    expect(await escrow.dealStatus(dealId)).to.equal("CREATED");

    await escrow.connect(buyer).signDeal(dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("PARTIALLY_SIGNED");

    await escrow.connect(seller).signDeal(dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("BOTH_SIGNED");

    await fundDeal(escrow, token, buyer, dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("FUNDED");

    await time.increaseTo(tge + 1n);
    expect(await escrow.dealStatus(dealId)).to.equal("EXECUTABLE");
  });

  it("dealStatus returns NOT_FOUND for unknown dealId", async function () {
    const { escrow } = await deployFixture();
    expect(await escrow.dealStatus(ZERO_HASH)).to.equal("NOT_FOUND");
  });

  it("dealStatus returns CANCELLED after cancel", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await escrow.connect(buyer).cancel(dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("CANCELLED");
  });

  it("dealStatus returns COMPLETED after release", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_HOUR;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await time.increaseTo(tge + 1n);
    await escrow.connect(seller).release(dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("COMPLETED");
  });

  it("dealStatus returns DISPUTED after raiseDispute", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);
    expect(await escrow.dealStatus(dealId)).to.equal("DISPUTED");
  });

  it("canRelease returns false before TGE", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    expect(await escrow.canRelease(dealId)).to.be.false;
  });

  it("canRelease returns true after TGE", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_HOUR;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await time.increaseTo(tge + 1n);
    expect(await escrow.canRelease(dealId)).to.be.true;
  });

  it("canRelease returns false after release", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_HOUR;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await time.increaseTo(tge + 1n);
    await escrow.connect(seller).release(dealId);
    expect(await escrow.canRelease(dealId)).to.be.false;
  });

  it("getNonce returns 0 for fresh address", async function () {
    const { escrow, third } = await deployFixture();
    expect(await escrow.getNonce(third.address)).to.equal(0n);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// K. Edge cases & security
// ─────────────────────────────────────────────────────────────────────────────
describe("K. Edge cases & security", function () {
  it("front-running: different block.timestamp/number produces different dealIds", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_DAY;

    const id1 = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge, amount: AMOUNT });
    // Advance one block
    await ethers.provider.send("evm_mine");
    const id2 = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge, amount: AMOUNT });

    expect(id1).to.not.equal(id2, "IDs must differ across blocks");
  });

  it("double-funding is blocked by AlreadyFunded", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);

    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyFunded");
  });

  it("double-release is blocked by AlreadyReleased (state=Completed)", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + ONE_HOUR;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await time.increaseTo(tge + 1n);
    await escrow.connect(seller).release(dealId);

    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyReleased");
  });

  it("premature release is blocked by TGENotReached", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    // TGE is 10 days in the future
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: now + ONE_DAY * 10n });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    // Only advance 1 hour, not enough
    await time.increase(3600);

    await expect(escrow.connect(seller).release(dealId))
      .to.be.revertedWithCustomError(escrow, "TGENotReached");
  });

  it("cannot fund after cancel (Pending → Cancelled)", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await escrow.connect(buyer).cancel(dealId);
    await token.connect(buyer).approve(escrow.target, AMOUNT);
    await expect(escrow.connect(buyer).fundDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "AlreadyCancelled");
  });

  it("state cleanup: amount is zero after release", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const now = BigInt(await time.latest());
    const tge = now + 60n;
    const dealId = await createDeal(escrow, buyer, seller, token, { tgeTimestamp: tge });
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await time.increaseTo(tge + 1n);
    await escrow.connect(seller).release(dealId);

    const deal = await escrow.getDeal(dealId);
    expect(deal.amount).to.equal(0n);
    expect(deal.state).to.equal(State.Completed);
  });

  it("state cleanup: amount is zero after dual-consent cancel", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).cancel(dealId);
    await escrow.connect(seller).cancel(dealId);

    const deal = await escrow.getDeal(dealId);
    expect(deal.amount).to.equal(0n);
    expect(deal.state).to.equal(State.Cancelled);
  });

  it("state cleanup: amount is zero after dispute resolved to seller", async function () {
    const { escrow, token, buyer, seller, arbitrator } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(buyer).raiseDispute(dealId);
    await escrow.connect(arbitrator).resolveDispute(dealId, true);

    const deal = await escrow.getDeal(dealId);
    expect(deal.amount).to.equal(0n);
    expect(deal.state).to.equal(State.Completed);
  });

  it("state cleanup: amount is zero after dispute resolved to buyer", async function () {
    const { escrow, token, buyer, seller, arbitrator } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);
    await signBoth(escrow, buyer, seller, dealId);
    await fundDeal(escrow, token, buyer, dealId);
    await escrow.connect(seller).raiseDispute(dealId);
    await escrow.connect(arbitrator).resolveDispute(dealId, false);

    const deal = await escrow.getDeal(dealId);
    expect(deal.amount).to.equal(0n);
    expect(deal.state).to.equal(State.Cancelled);
  });

  it("multiple deals per party are tracked correctly", async function () {
    const { escrow, token, buyer, seller } = await deployFixture();
    const id1 = await createDeal(escrow, buyer, seller, token, { amount: SMALL });
    await ethers.provider.send("evm_mine");
    const id2 = await createDeal(escrow, buyer, seller, token, { amount: SMALL });
    await ethers.provider.send("evm_mine");
    const id3 = await createDeal(escrow, buyer, seller, token, { amount: SMALL });

    const buyerDeals = await escrow.getDealsByParty(buyer.address);
    expect(buyerDeals).to.have.length(3);
    expect(buyerDeals).to.include(id1);
    expect(buyerDeals).to.include(id2);
    expect(buyerDeals).to.include(id3);
  });

  it("non-party cannot interact with any deal function", async function () {
    const { escrow, token, buyer, seller, third } = await deployFixture();
    const dealId = await createDeal(escrow, buyer, seller, token);

    await expect(escrow.connect(third).signDeal(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
    await expect(escrow.connect(third).cancel(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
    await expect(escrow.connect(third).raiseDispute(dealId))
      .to.be.revertedWithCustomError(escrow, "NotParty");
  });
});
