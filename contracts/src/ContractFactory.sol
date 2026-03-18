// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

// ============================================================
//  ContractFactory — Arc Testnet
//  Creates and manages on-chain work contracts with milestones.
//
//  Tokens:
//    USDC  0x3600000000000000000000000000000000000000 (native, 6 dec)
//
//  Flow:
//    1. client calls createContract(...) + approve(factory, amount) first
//    2. contractor calls signContract(id) → status = Active
//    3. client calls completeMilestone(id, idx) → releases payment
//    4. client can cancelContract before signing → full refund
// ============================================================

interface IERC20 {
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function transfer(address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
    function allowance(address owner, address spender) external view returns (uint256);
}

contract ContractFactory {

    // ─── Types ────────────────────────────────────────────────────────────────
    enum Status { Draft, Active, Completed, Cancelled }
    enum MsStatus { Pending, Released }

    struct Milestone {
        uint256  id;
        string   description;
        uint256  amount;        // micro-USDC (6 decimals)
        MsStatus status;
        uint256  releasedAt;
    }

    struct WorkContract {
        uint256 id;
        address client;
        address contractor;
        string  title;
        uint256 totalValue;     // micro-USDC
        uint256 depositedValue;
        Status  status;
        bool    contractorSigned;
        uint256 createdAt;
        uint256 startedAt;
        uint256 completedAt;
        uint256 milestoneCount;
        uint256 completedMilestones;
    }

    // ─── Storage ──────────────────────────────────────────────────────────────
    address public immutable usdc;
    address public owner;
    uint256 public contractCount;

    mapping(uint256 => WorkContract) public contracts;
    mapping(uint256 => Milestone[])  public milestones;
    // index: wallet → list of contractIds
    mapping(address => uint256[])    public byClient;
    mapping(address => uint256[])    public byContractor;

    // ─── Events ───────────────────────────────────────────────────────────────
    event ContractCreated(
        uint256 indexed contractId,
        address indexed client,
        address indexed contractor,
        string  title,
        uint256 totalValue,
        uint256 milestoneCount,
        uint256 timestamp
    );
    event ContractSigned(
        uint256 indexed contractId,
        address indexed contractor,
        uint256 timestamp
    );
    event MilestoneReleased(
        uint256 indexed contractId,
        uint256 indexed milestoneIndex,
        address indexed contractor,
        uint256 amount,
        uint256 timestamp
    );
    event ContractCancelled(
        uint256 indexed contractId,
        address indexed client,
        uint256 refundAmount,
        uint256 timestamp
    );

    // ─── Constructor ──────────────────────────────────────────────────────────
    constructor(address _usdc) {
        require(_usdc != address(0), "Zero usdc");
        usdc  = _usdc;
        owner = msg.sender;
    }

    modifier onlyOwner() { require(msg.sender == owner, "Not owner"); _; }
    modifier exists(uint256 id) { require(id > 0 && id <= contractCount, "Not found"); _; }

    // ─── createContract ───────────────────────────────────────────────────────
    // Caller MUST call USDC.approve(factoryAddress, totalValue) first.
    function createContract(
        address   _contractor,
        string    calldata _title,
        uint256   _totalValue,
        string[]  calldata _mDesc,
        uint256[] calldata _mAmts
    ) external returns (uint256) {
        _validateCreate(_contractor, _title, _totalValue, _mDesc, _mAmts);

        // Pull USDC from caller
        bool ok = IERC20(usdc).transferFrom(msg.sender, address(this), _totalValue);
        require(ok, "USDC transferFrom failed");

        contractCount++;
        uint256 cid = contractCount;

        // Store contract
        WorkContract storage c = contracts[cid];
        c.id               = cid;
        c.client           = msg.sender;
        c.contractor       = _contractor;
        c.title            = _title;
        c.totalValue       = _totalValue;
        c.depositedValue   = _totalValue;
        c.status           = Status.Draft;
        c.contractorSigned = false;
        c.createdAt        = block.timestamp;
        c.milestoneCount   = _mDesc.length;

        // Store milestones
        for (uint256 i; i < _mDesc.length;) {
            milestones[cid].push(Milestone({
                id:          i + 1,
                description: _mDesc[i],
                amount:      _mAmts[i],
                status:      MsStatus.Pending,
                releasedAt:  0
            }));
            unchecked { i++; }
        }

        byClient[msg.sender].push(cid);
        byContractor[_contractor].push(cid);

        emit ContractCreated(cid, msg.sender, _contractor, _title, _totalValue, _mDesc.length, block.timestamp);
        return cid;
    }

    function _validateCreate(
        address   _contractor,
        string    calldata _title,
        uint256   _totalValue,
        string[]  calldata _mDesc,
        uint256[] calldata _mAmts
    ) internal view {
        require(_contractor != address(0), "Bad contractor");
        require(_contractor != msg.sender,  "Same addr");
        require(bytes(_title).length > 0,   "Empty title");
        require(_totalValue > 0,            "Zero value");
        require(_mDesc.length > 0,          "Need milestones");
        require(_mDesc.length <= 10,        "Max 10");
        require(_mDesc.length == _mAmts.length, "Length mismatch");

        uint256 sum;
        for (uint256 i; i < _mAmts.length;) {
            require(_mAmts[i] > 0, "Zero ms amount");
            sum += _mAmts[i];
            unchecked { i++; }
        }
        require(sum == _totalValue, "Sum != total");

        require(
            IERC20(usdc).allowance(msg.sender, address(this)) >= _totalValue,
            "Allowance too low: call approve() first"
        );
    }

    // ─── signContract ─────────────────────────────────────────────────────────
    function signContract(uint256 _cid) external exists(_cid) {
        WorkContract storage c = contracts[_cid];
        require(c.status == Status.Draft,       "Not draft");
        require(msg.sender == c.contractor,      "Not contractor");
        require(!c.contractorSigned,             "Already signed");

        c.contractorSigned = true;
        c.status           = Status.Active;
        c.startedAt        = block.timestamp;

        emit ContractSigned(_cid, msg.sender, block.timestamp);
    }

    // ─── completeMilestone ────────────────────────────────────────────────────
    function completeMilestone(uint256 _cid, uint256 _idx) external exists(_cid) {
        WorkContract storage c = contracts[_cid];
        require(c.status == Status.Active,       "Not active");
        require(msg.sender == c.client,           "Not client");
        require(_idx < milestones[_cid].length,  "Bad index");

        Milestone storage ms = milestones[_cid][_idx];
        require(ms.status == MsStatus.Pending,   "Already released");

        ms.status     = MsStatus.Released;
        ms.releasedAt = block.timestamp;
        c.completedMilestones++;

        bool ok = IERC20(usdc).transfer(c.contractor, ms.amount);
        require(ok, "Payment failed");

        emit MilestoneReleased(_cid, _idx, c.contractor, ms.amount, block.timestamp);

        if (c.completedMilestones == c.milestoneCount) {
            c.status      = Status.Completed;
            c.completedAt = block.timestamp;
        }
    }

    // ─── cancelContract ───────────────────────────────────────────────────────
    function cancelContract(uint256 _cid) external exists(_cid) {
        WorkContract storage c = contracts[_cid];
        require(c.status == Status.Draft,  "Only cancel Draft");
        require(msg.sender == c.client,    "Not client");

        c.status = Status.Cancelled;
        uint256 refund = c.depositedValue;
        c.depositedValue = 0;

        if (refund > 0) {
            bool ok = IERC20(usdc).transfer(c.client, refund);
            require(ok, "Refund failed");
        }

        emit ContractCancelled(_cid, msg.sender, refund, block.timestamp);
    }

    // ─── View helpers ─────────────────────────────────────────────────────────
    function getContract(uint256 _cid) external view exists(_cid) returns (WorkContract memory) {
        return contracts[_cid];
    }

    function getMilestones(uint256 _cid) external view exists(_cid) returns (Milestone[] memory) {
        return milestones[_cid];
    }

    function getByClient(address _a) external view returns (uint256[] memory) {
        return byClient[_a];
    }

    function getByContractor(address _a) external view returns (uint256[] memory) {
        return byContractor[_a];
    }

    function getByParticipant(address _a) external view returns (uint256[] memory ids) {
        uint256[] storage clist = byClient[_a];
        uint256[] storage ctorList = byContractor[_a];
        uint256 total = clist.length + ctorList.length;
        ids = new uint256[](total);
        uint256 k;
        for (uint256 i; i < clist.length;) { ids[k] = clist[i]; unchecked { k++; i++; } }
        for (uint256 i; i < ctorList.length;) { ids[k] = ctorList[i]; unchecked { k++; i++; } }
    }

    // Owner
    function transferOwnership(address _new) external onlyOwner {
        require(_new != address(0), "Zero");
        owner = _new;
    }
}
