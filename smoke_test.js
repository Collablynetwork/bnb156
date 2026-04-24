const fs = require('fs');
const path = require('path');
const assert = require('assert');

const projectDir = __dirname;
const storageDir = path.join(projectDir, 'storage');
if (fs.existsSync(storageDir)) fs.rmSync(storageDir, { recursive: true, force: true });

const state = require('./state');
state.ensureStorage();
const signals = require('./signals');
const dryrun = require('./dryrun');
const config = require('./config');
const { buildSignalMessage } = require('./telegramMessageBuilder');

function makeFeatures(overrides = {}) {
  return {
    currentClose: 100,
    atr14: 0.5,
    support: 99.4,
    resistance: 101.8,
    recentHigh20: 101.3,
    recentLow20: 98.7,
    bbBasis: 100.5,
    ...overrides,
  };
}

function makeMatch(overrides = {}) {
  const { current: currentOverride = {}, ...rest } = overrides;
  return {
    pair: 'BTCUSDT',
    direction: 'long',
    score: 86,
    baseTimeframe: '1m',
    current: {
      features: makeFeatures(currentOverride.features || {}),
      flow: currentOverride.flow || {},
    },
    supportTimeframes: ['1m', '3m', '5m'],
    reasons: ['rule A', 'rule B'],
    ...rest,
  };
}

// 1) Candidate strict filtering
assert.strictEqual(signals.buildSignalCandidate(makeMatch({ baseTimeframe: '15m' })), null, '15m should be rejected');
assert.strictEqual(signals.buildSignalCandidate(makeMatch({ supportTimeframes: ['1m', '3m'] })), null, 'Need 3 support timeframes');

const candidate = signals.buildSignalCandidate(makeMatch());
assert(candidate, '1m candidate with 3 supports should pass');
assert.strictEqual(candidate.baseTimeframe, '1m');
assert.strictEqual(candidate.supportTfs.length, 3);
assert.strictEqual(candidate.target1Price.toFixed(4), '100.2000');
assert.strictEqual(candidate.sl1Price.toFixed(4), '99.8000');
assert(candidate.target2Price < candidate.originalSystemTp1, 'Long adjusted TP1 should be lower');
assert(candidate.sl2Price < candidate.originalSystemSl, 'Long adjusted SL should be lower');

// 1b) Funding rate direction filter
const fundingLong = signals.buildSignalCandidate(
  makeMatch({
    current: {
      features: makeFeatures({ currentClose: 100, bbBasis: 100.5 }),
      flow: { fundingRate: -0.0002 },
    },
  })
);
assert(fundingLong, 'Negative funding should allow LONG when price is below BB mid-band');
assert.strictEqual(fundingLong.side, 'LONG');
assert.strictEqual(fundingLong.fundingBias, 'LONG');
assert(buildSignalMessage(fundingLong).includes('Funding Rate'), 'Telegram signal message should include funding rate');

const blockedShortOnNegativeFunding = signals.buildSignalCandidate(
  makeMatch({
    direction: 'short',
    current: {
      features: makeFeatures({ currentClose: 101, bbBasis: 100.5 }),
      flow: { fundingRate: -0.0002 },
    },
  })
);
assert.strictEqual(blockedShortOnNegativeFunding, null, 'Negative funding should block SHORT signals');

const blockedLongAboveMidBand = signals.buildSignalCandidate(
  makeMatch({
    current: {
      features: makeFeatures({ currentClose: 101, bbBasis: 100.5 }),
      flow: { fundingRate: -0.0002 },
    },
  })
);
assert.strictEqual(blockedLongAboveMidBand, null, 'Negative funding LONG must stay below BB mid-band');

const fundingShort = signals.buildSignalCandidate(
  makeMatch({
    direction: 'short',
    current: {
      features: makeFeatures({
        currentClose: 100.9,
        bbBasis: 100.5,
        support: 99.1,
        resistance: 101.7,
        recentHigh20: 101.8,
        recentLow20: 98.9,
      }),
      flow: { fundingRate: 0.0002 },
    },
  })
);
assert(fundingShort, 'Positive funding should allow SHORT when price is above BB mid-band');
assert.strictEqual(fundingShort.side, 'SHORT');
assert.strictEqual(fundingShort.fundingBias, 'SHORT');

// 2) One blocking signal at a time
const first = dryrun.registerSignal({ ...candidate, signalKey: signals.buildSignalKey(candidate), signalMessageId: 111 });
assert(first, 'First signal should register');
assert.strictEqual(dryrun.canOpenNewSignal(), false, 'Gate should be blocked after first open');

const blocked = dryrun.registerSignal({ ...candidate, pair: 'ETHUSDT', signalKey: 'ETHUSDT|LONG|1m', signalMessageId: 222 });
assert.strictEqual(blocked, null, 'Second signal must be blocked while first is fully open');

// 3) PNL1 closes first, gate opens, PNL2 still monitored
let updates = dryrun.evaluateTargetsAndStops({ BTCUSDT: candidate.target1Price + 0.01 });
assert(updates.some((u) => u.type === 'TARGET ACHIEVED 1'), 'PNL1 target should close');
let open = dryrun.loadOpenPositions();
assert.strictEqual(open.length, 1, 'Trade should remain monitored after first model closes');
assert.strictEqual(open[0].pnl1Status, 'TARGET ACHIEVED 1');
assert.strictEqual(open[0].pnl2Status, 'OPEN');
assert.strictEqual(open[0].blocksNewSignals, false, 'Gate should open after first model closes');
assert.strictEqual(dryrun.canOpenNewSignal(), true, 'New signal should be allowed after PNL1 closes');

// 4) New signal can open while first trade still monitoring PNL2
const secondCandidate = signals.buildSignalCandidate(makeMatch({ pair: 'ETHUSDT', current: { features: { currentClose: 200, atr14: 1, support: 198.5, resistance: 203.2, recentHigh20: 202.1, recentLow20: 197.3 } }, supportTimeframes: ['1m','3m','5m'], score: 87 }));
const second = dryrun.registerSignal({ ...secondCandidate, signalKey: signals.buildSignalKey(secondCandidate), signalMessageId: 333 });
assert(second, 'Second signal should open after first model closure of previous trade');

// 5) Finish first trade via PNL2 target and verify full close
updates = dryrun.evaluateTargetsAndStops({ BTCUSDT: candidate.target2Price + 0.01, ETHUSDT: secondCandidate.entryPrice });
assert(updates.some((u) => u.type === 'TARGET ACHIEVED 2' && u.pair === 'BTCUSDT'), 'PNL2 target should close');
const closed = dryrun.loadClosedTrades();
assert(closed.some((t) => t.pair === 'BTCUSDT' && t.pnl1Status === 'TARGET ACHIEVED 1' && t.pnl2Status === 'TARGET ACHIEVED 2'), 'BTC trade should be fully closed');

// 6) Stats must track each model separately
const pnl1 = dryrun.pnlModelSummary('pnl1');
const pnl2 = dryrun.pnlModelSummary('pnl2');
assert(pnl1.totalSignals >= 2, 'PNL1 total signals should count all trades');
assert(pnl1.targetCount >= 1, 'PNL1 target count should update');
assert(pnl2.targetCount >= 1, 'PNL2 target count should update');

// 7) Active signal slots should be configurable
state.clearAllTradingStatus();
state.saveRuntimeSettings({ activeSignalSlots: 2 });
assert.strictEqual(state.getRuntimeSettings().activeSignalSlots, 2, 'Runtime settings should persist slot count');

const slotCandidate1 = signals.buildSignalCandidate(makeMatch({ pair: 'BTCUSDT' }));
const slotCandidate2 = signals.buildSignalCandidate(
  makeMatch({
    pair: 'ETHUSDT',
    current: { features: makeFeatures({ currentClose: 200, support: 198.5, resistance: 203.2, recentHigh20: 202.1, recentLow20: 197.3, bbBasis: 200.5 }) },
  })
);
const slotCandidate3 = signals.buildSignalCandidate(
  makeMatch({
    pair: 'XRPUSDT',
    current: { features: makeFeatures({ currentClose: 0.51, support: 0.5, resistance: 0.53, recentHigh20: 0.525, recentLow20: 0.49, bbBasis: 0.515 }) },
  })
);

assert(dryrun.registerSignal({ ...slotCandidate1, signalKey: signals.buildSignalKey(slotCandidate1), signalMessageId: 444 }), 'First blocking signal should open with 2 slots');
assert(dryrun.registerSignal({ ...slotCandidate2, signalKey: signals.buildSignalKey(slotCandidate2), signalMessageId: 555 }), 'Second blocking signal should open with 2 slots');
assert.strictEqual(dryrun.canOpenNewSignal(), false, 'Gate should close after all configured slots are used');
assert.strictEqual(
  dryrun.registerSignal({ ...slotCandidate3, signalKey: signals.buildSignalKey(slotCandidate3), signalMessageId: 666 }),
  null,
  'Third blocking signal should be rejected when slot limit is reached'
);

console.log('All smoke tests passed');
console.log(JSON.stringify({
  candidate,
  fundingLong,
  fundingShort,
  pnl1,
  pnl2,
  openTrades: dryrun.loadOpenPositions().length,
  closedTrades: dryrun.loadClosedTrades().length,
}, null, 2));
