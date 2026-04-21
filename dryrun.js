const config = require("./config");
const { readJson, writeJson, nowIso } = require("./state");
const { round } = require("./indicators");

function loadOpenPositions() {
  return readJson(config.dryRunPositionsPath, []);
}

function saveOpenPositions(positions) {
  writeJson(config.dryRunPositionsPath, positions);
}

function loadClosedTrades() {
  return readJson(config.closedTradesPath, []);
}

function saveClosedTrades(trades) {
  writeJson(config.closedTradesPath, trades);
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
}

function asDecimalPercent(value) {
  return Number(value || 0) / 100;
}

function computeSignedPct(side, entry, exitPrice) {
  if (!Number.isFinite(entry) || entry <= 0 || !Number.isFinite(exitPrice)) return 0;
  if (String(side).toUpperCase() === "SHORT") {
    return ((entry - exitPrice) / entry) * 100;
  }
  return ((exitPrice - entry) / entry) * 100;
}

function computeSignedAmount(notional, pct) {
  return round(Number(notional || 0) * (Number(pct || 0) / 100), 6);
}

function getSignalKey(signal) {
  return String(
    signal.signalKey ||
      [signal.pair, signal.side, signal.baseTimeframe].map((v) => String(v || "").toUpperCase()).join("|")
  );
}

function buildStrategyUsed(signal) {
  return (
    signal.strategyUsed ||
    signal.strategySource ||
    `${signal.strategySourcePair || signal.sourcePair || "N/A"} ${signal.strategySourceTimeframe || signal.sourceTimeframe || ""}`.trim()
  );
}

function createPosition(signal) {
  const notional = Number(config.dryRunNotional || 100);
  const entry = Number(signal.entryPrice ?? signal.entry ?? 0);
  const qty = entry > 0 ? notional / entry : 0;

  return {
    signalId: signal.signalId || `${signal.pair}-${signal.side}-${signal.baseTimeframe}-${Date.now()}`,
    id: signal.signalId || `${signal.pair}-${signal.side}-${signal.baseTimeframe}-${Date.now()}`,
    signalKey: getSignalKey(signal),
    pair: String(signal.pair || "").toUpperCase(),
    side: String(signal.side || "LONG").toUpperCase(),
    baseTimeframe: signal.baseTimeframe,
    supportTimeframes: uniqueStrings(signal.supportTimeframes || signal.supportTfs || []),
    supportTimeframeCount: uniqueStrings(signal.supportTimeframes || signal.supportTfs || []).length,
    entryPrice: entry,
    entry: entry,
    quantity: round(qty, 8),
    notional,
    target1Price: Number(signal.target1Price),
    target2Price: Number(signal.target2Price),
    sl1Price: Number(signal.sl1Price),
    sl2Price: Number(signal.sl2Price),
    tp1: Number(signal.target2Price),
    tp2: Number(signal.ignoredTp3),
    tp3: Number(signal.ignoredTp4),
    ignoredTp3: Number(signal.ignoredTp3),
    ignoredTp4: Number(signal.ignoredTp4),
    originalSystemTp1: Number(signal.originalSystemTp1),
    originalSystemSl: Number(signal.originalSystemSl),
    strategyUsed: buildStrategyUsed(signal),
    strategySource: buildStrategyUsed(signal),
    score: Number(signal.score || 0),
    signalMessageId: signal.signalMessageId || null,
    messageId: signal.signalMessageId || null,
    openedAt: nowIso(),
    openTime: nowIso(),
    firstClosedAt: null,
    closeTime: null,
    currentMark: entry,
    unrealizedPnl: 0,
    realizedPnl: 0,
    pnl1Status: "OPEN",
    pnl2Status: "OPEN",
    pnl1ClosedAt: null,
    pnl2ClosedAt: null,
    pnl1ExitPrice: null,
    pnl2ExitPrice: null,
    pnl1PnlPct: 0,
    pnl2PnlPct: 0,
    pnl1PnlAmount: 0,
    pnl2PnlAmount: 0,
    blocksNewSignals: true,
    monitoringActive: true,
    status: "OPEN",
  };
}

function updatePositionMark(position, mark) {
  position.currentMark = mark;
  const move = position.side === "LONG" ? mark - position.entryPrice : position.entryPrice - mark;
  position.unrealizedPnl = round(move * position.quantity, 6);
  return position;
}

function isFullyClosed(position) {
  return position.pnl1Status !== "OPEN" && position.pnl2Status !== "OPEN";
}

function releaseSignalGate(position) {
  if (position.blocksNewSignals && (position.pnl1Status !== "OPEN" || position.pnl2Status !== "OPEN")) {
    position.blocksNewSignals = false;
    position.firstClosedAt = position.firstClosedAt || nowIso();
  }
}

function refreshOverallStatus(position) {
  if (isFullyClosed(position)) {
    position.monitoringActive = false;
    position.status = "CLOSED";
    position.closeTime = position.closeTime || nowIso();
    position.closedAt = position.closeTime;
    position.realizedPnl = round((position.pnl1PnlAmount || 0) + (position.pnl2PnlAmount || 0), 6);
  } else if (position.pnl1Status !== "OPEN" || position.pnl2Status !== "OPEN") {
    position.status = "PARTIAL";
  } else {
    position.status = "OPEN";
  }
  return position;
}

function markModelClosed(position, model, status, exitPrice) {
  const now = nowIso();
  const pct = computeSignedPct(position.side, position.entryPrice, exitPrice);
  const amount = computeSignedAmount(position.notional, pct);

  if (model === "PNL1") {
    if (position.pnl1Status !== "OPEN") return null;
    position.pnl1Status = status;
    position.pnl1ClosedAt = now;
    position.pnl1ExitPrice = exitPrice;
    position.pnl1PnlPct = round(pct, 6);
    position.pnl1PnlAmount = amount;
  } else {
    if (position.pnl2Status !== "OPEN") return null;
    position.pnl2Status = status;
    position.pnl2ClosedAt = now;
    position.pnl2ExitPrice = exitPrice;
    position.pnl2PnlPct = round(pct, 6);
    position.pnl2PnlAmount = amount;
  }

  releaseSignalGate(position);
  refreshOverallStatus(position);

  return {
    type: status,
    position: { ...position },
    pair: position.pair,
    side: position.side,
    signalKey: position.signalKey,
    signalMessageId: position.signalMessageId,
  };
}

function findExistingTrackedSignal(pair, side, baseTimeframe) {
  return loadOpenPositions().find(
    (p) =>
      p.pair === String(pair || "").toUpperCase() &&
      p.side === String(side || "").toUpperCase() &&
      p.baseTimeframe === baseTimeframe &&
      p.monitoringActive &&
      p.blocksNewSignals
  );
}

function canOpenNewSignal() {
  return !loadOpenPositions().some((p) => p.monitoringActive && p.blocksNewSignals);
}

function registerSignal(signal) {
  const existing = findExistingTrackedSignal(signal.pair, signal.side, signal.baseTimeframe);
  if (existing) return existing;
  if (!canOpenNewSignal()) return null;

  const positions = loadOpenPositions();
  const position = createPosition(signal);
  positions.push(position);
  saveOpenPositions(positions);
  return position;
}

function attachSignalMessage(signalId, messageId, signalKey) {
  const positions = loadOpenPositions();
  let updated = null;

  for (const position of positions) {
    if (position.signalId === signalId || position.id === signalId || position.signalKey === signalKey) {
      position.signalMessageId = messageId || position.signalMessageId;
      position.messageId = messageId || position.messageId;
      if (signalKey) position.signalKey = signalKey;
      updated = { ...position };
      break;
    }
  }

  if (updated) saveOpenPositions(positions);
  return updated;
}

function evaluateTargetsAndStops(priceByPair) {
  const openPositions = loadOpenPositions();
  const stillOpen = [];
  const closedTrades = loadClosedTrades();
  const updates = [];

  for (const position of openPositions) {
    const mark = Number(priceByPair[position.pair]);
    if (!Number.isFinite(mark)) {
      stillOpen.push(position);
      continue;
    }

    updatePositionMark(position, mark);

    if (position.pnl1Status === "OPEN") {
      const pnl1TargetHit =
        position.side === "LONG" ? mark >= position.target1Price : mark <= position.target1Price;
      const pnl1StopHit =
        position.side === "LONG" ? mark <= position.sl1Price : mark >= position.sl1Price;

      if (pnl1TargetHit) {
        const event = markModelClosed(position, "PNL1", "TARGET ACHIEVED 1", position.target1Price);
        if (event) updates.push(event);
      } else if (pnl1StopHit) {
        const event = markModelClosed(position, "PNL1", "SL1", position.sl1Price);
        if (event) updates.push(event);
      }
    }

    if (position.pnl2Status === "OPEN") {
      const pnl2TargetHit =
        position.side === "LONG" ? mark >= position.target2Price : mark <= position.target2Price;
      const pnl2StopHit =
        position.side === "LONG" ? mark <= position.sl2Price : mark >= position.sl2Price;

      if (pnl2TargetHit) {
        const event = markModelClosed(position, "PNL2", "TARGET ACHIEVED 2", position.target2Price);
        if (event) updates.push(event);
      } else if (pnl2StopHit) {
        const event = markModelClosed(position, "PNL2", "SL2", position.sl2Price);
        if (event) updates.push(event);
      }
    }

    refreshOverallStatus(position);

    if (isFullyClosed(position)) {
      closedTrades.push({ ...position });
    } else {
      stillOpen.push(position);
    }
  }

  saveOpenPositions(stillOpen);
  saveClosedTrades(closedTrades);
  return updates;
}

function getAllTrades() {
  return [...loadOpenPositions(), ...loadClosedTrades()];
}

function summarizeModel(trades, model) {
  const targetStatus = model === "pnl1" ? "TARGET ACHIEVED 1" : "TARGET ACHIEVED 2";
  const stopStatus = model === "pnl1" ? "SL1" : "SL2";
  const statusField = model === "pnl1" ? "pnl1Status" : "pnl2Status";
  const pnlField = model === "pnl1" ? "pnl1PnlAmount" : "pnl2PnlAmount";

  const totalSignals = trades.length;
  const targetCount = trades.filter((t) => t[statusField] === targetStatus).length;
  const slCount = trades.filter((t) => t[statusField] === stopStatus).length;
  const cumulativeProfitLoss = round(
    trades.reduce((sum, t) => sum + Number(t[pnlField] || 0), 0),
    6
  );

  return {
    totalSignals,
    targetCount,
    slCount,
    winRate: totalSignals ? round((targetCount / totalSignals) * 100, 2) : 0,
    lossRate: totalSignals ? round((slCount / totalSignals) * 100, 2) : 0,
    cumulativeProfitLoss,
  };
}

function pnlModelSummary(model) {
  return summarizeModel(getAllTrades(), model);
}

function pnlSummary() {
  const openPositions = loadOpenPositions();
  const closedTrades = loadClosedTrades();
  const allTrades = [...openPositions, ...closedTrades];
  const blocking = openPositions.filter((p) => p.blocksNewSignals).length;
  const partiallyMonitoring = openPositions.filter((p) => !p.blocksNewSignals).length;

  return {
    openCount: openPositions.length,
    closedCount: closedTrades.length,
    blockingSignals: blocking,
    backgroundMonitoring: partiallyMonitoring,
    openUnrealized: round(openPositions.reduce((sum, p) => sum + Number(p.unrealizedPnl || 0), 0), 6),
    realized: round(allTrades.reduce((sum, p) => sum + Number(p.pnl1PnlAmount || 0) + Number(p.pnl2PnlAmount || 0), 0), 6),
    pnl1: summarizeModel(allTrades, "pnl1"),
    pnl2: summarizeModel(allTrades, "pnl2"),
  };
}

module.exports = {
  loadOpenPositions,
  saveOpenPositions,
  loadClosedTrades,
  saveClosedTrades,
  getAllTrades,
  registerSignal,
  attachSignalMessage,
  evaluateTargetsAndStops,
  pnlSummary,
  pnlModelSummary,
  canOpenNewSignal,
  findExistingTrackedSignal,
  findExistingOpen: findExistingTrackedSignal,
};
