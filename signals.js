const config = require("./config");
const state = require("./state");
const dryrun = require("./dryrun");
const {
  buildSignalMessage,
  buildSignalReplyMarkup,
  buildScoreRisingMessage,
  buildTargetHitMessage,
  buildStopHitMessage,
} = require("./telegramMessageBuilder");

function getBand(score) {
  const value = Number(score || 0);
  if (value >= config.alertThreshold) return "alert";
  if (value > config.notifyMinScore) return "strong";
  if (value >= config.watchThreshold) return "watch";
  return "low";
}

function bandRank(band) {
  return { low: 0, watch: 1, strong: 2, alert: 3 }[band] ?? 0;
}

function normalizeCandidate(candidate) {
  if (!candidate) return null;

  return {
    ...candidate,
    pair: String(candidate.pair || candidate.symbol || "").toUpperCase(),
    side:
      String(candidate.side || candidate.direction || "LONG").toUpperCase() === "SHORT"
        ? "SHORT"
        : "LONG",
    baseTimeframe: candidate.baseTimeframe || candidate.baseTf || "N/A",
    supportTfs:
      candidate.supportTfs ||
      candidate.supportTimeframes ||
      candidate.supportingTimeframes ||
      candidate.validationTfs ||
      [],
  };
}

function buildSignalKey(candidate) {
  return [
    String(candidate.pair).toUpperCase(),
    String(candidate.side).toUpperCase(),
    String(candidate.baseTimeframe || candidate.baseTf || "N/A"),
  ].join("|");
}

function uniqueStrings(values) {
  return [...new Set((values || []).map((v) => String(v).trim()).filter(Boolean))];
}

function pctPrice(entry, pct, side, kind) {
  const value = Number(entry || 0);
  const move = value * (Number(pct || 0) / 100);
  const isShort = String(side).toUpperCase() === "SHORT";
  if (kind === "target") {
    return isShort ? value - move : value + move;
  }
  return isShort ? value + move : value - move;
}

function adjustSystemValue(value, side, direction) {
  const base = Number(value || 0);
  const adjustPct = direction === "target" ? config.systemTargetAdjustPct : config.systemStopAdjustPct;
  const factor = Number(adjustPct || 0) / 100;
  const isShort = String(side).toUpperCase() === "SHORT";

  if (!Number.isFinite(base) || base <= 0) return 0;
  if (isShort) {
    return base * (1 + factor);
  }
  return base * (1 - factor);
}

function chooseStopAndTargets(side, entry, currentFeatures = {}) {
  const atr = Number(currentFeatures.atr14 || 0);
  const minRisk = Math.max(entry * 0.003, atr * 1.1, entry * 0.0015);
  const longSupport = Number(currentFeatures.support);
  const shortResistance = Number(currentFeatures.resistance);
  const recentHigh = Number(currentFeatures.recentHigh20);
  const recentLow = Number(currentFeatures.recentLow20);

  let sl;
  let tp4;

  if (side === "LONG") {
    const stopCandidate =
      Number.isFinite(longSupport) && longSupport > 0 && longSupport < entry
        ? longSupport
        : entry - minRisk;
    sl = Math.min(stopCandidate, entry - Math.max(minRisk * 0.5, entry * 0.001));
    const risk = Math.max(entry - sl, minRisk);
    const resistanceTarget =
      Number.isFinite(shortResistance) && shortResistance > entry ? shortResistance : null;
    tp4 = Math.max(entry + risk * 2.5, resistanceTarget || 0, entry + minRisk * 2.5);
    return {
      systemTp1: entry + risk,
      ignoredTp3: entry + risk * 1.75,
      ignoredTp4: tp4,
      systemSl: sl,
      riskReward: risk > 0 ? (tp4 - entry) / risk : null,
    };
  }

  const stopCandidate =
    Number.isFinite(shortResistance) && shortResistance > entry
      ? shortResistance
      : entry + minRisk;
  sl = Math.max(stopCandidate, entry + Math.max(minRisk * 0.5, entry * 0.001));
  const risk = Math.max(sl - entry, minRisk);
  const supportTarget = Number.isFinite(longSupport) && longSupport < entry ? longSupport : null;
  tp4 = Math.min(
    entry - risk * 2.5,
    supportTarget || entry - minRisk * 2.5,
    Number.isFinite(recentLow) ? recentLow : entry - minRisk * 2.5
  );

  return {
    systemTp1: entry - risk,
    ignoredTp3: entry - risk * 1.75,
    ignoredTp4: tp4,
    systemSl: sl,
    riskReward: risk > 0 ? (entry - tp4) / risk : null,
  };
}

function buildSignalCandidate(matchResult) {
  if (!matchResult) return null;
  const score = Number(matchResult.score);
  if (!Number.isFinite(score)) return null;
  if (score <= Number(config.notifyMinScore || 80)) return null;

  const side =
    String(matchResult.side || matchResult.direction || "LONG").toUpperCase() === "SHORT"
      ? "SHORT"
      : "LONG";
  const baseTimeframe = matchResult.baseTimeframe || matchResult.baseTf || "N/A";
  if (!config.allowedBaseTimeframes.includes(baseTimeframe)) return null;

  const currentFeatures = matchResult.current?.features || {};
  const entry = Number(matchResult.entry ?? matchResult.entryPrice ?? currentFeatures.currentClose ?? 0);
  if (!Number.isFinite(entry) || entry <= 0) return null;

  const supportTfsRaw =
    matchResult.supportTfs ||
    matchResult.supportTimeframes ||
    matchResult.supportingTimeframes ||
    matchResult.validationTfs ||
    [];
  const supportTfs = uniqueStrings([baseTimeframe, ...supportTfsRaw]);
  if (supportTfs.length < Number(config.minSupportCount || 3)) return null;

  const generated = chooseStopAndTargets(side, entry, currentFeatures);
  const originalSystemTp1 = Number(matchResult.tp1 ?? generated.systemTp1);
  const originalSystemSl = Number(matchResult.sl ?? matchResult.stopLoss ?? generated.systemSl);
  const ignoredTp3 = Number(matchResult.tp2 ?? generated.ignoredTp3);
  const ignoredTp4 = Number(matchResult.tp3 ?? generated.ignoredTp4);

  const target1Price = pctPrice(entry, config.pnl1TargetPct, side, "target");
  const sl1Price = pctPrice(entry, config.pnl1StopPct, side, "stop");
  const target2Price = adjustSystemValue(originalSystemTp1, side, "target");
  const sl2Price = adjustSystemValue(originalSystemSl, side, "stop");
  const strategySourcePair =
    matchResult.strategySourcePair || matchResult.sourcePair || matchResult.strategy?.pair || "N/A";
  const strategySourceTimeframe =
    matchResult.strategySourceTimeframe ||
    matchResult.sourceTimeframe ||
    matchResult.strategy?.mainSourceTimeframe ||
    "N/A";
  const strategyUsed = `${strategySourcePair} ${strategySourceTimeframe}`.trim();

  return {
    pair: String(matchResult.pair || "").toUpperCase(),
    side,
    direction: side,
    score,
    entry,
    entryPrice: entry,
    currentPrice: Number(matchResult.currentPrice ?? currentFeatures.currentClose ?? entry),
    target1Price,
    target2Price,
    sl1Price,
    sl2Price,
    tp1: target2Price,
    tp2: ignoredTp3,
    tp3: ignoredTp4,
    ignoredTp3,
    ignoredTp4,
    originalSystemTp1,
    originalSystemSl,
    sl: sl2Price,
    stopLoss: sl2Price,
    baseTimeframe,
    baseTf: baseTimeframe,
    supportTfs,
    supportTimeframes: supportTfs,
    reasons: matchResult.reasons || [],
    strategySourcePair,
    strategySourceTimeframe,
    strategySource: strategyUsed,
    strategyUsed,
    similarityScore: Number(matchResult.similarityScore || score),
    riskReward: Number(matchResult.riskReward ?? generated.riskReward),
    regimeSupportScore: matchResult.regimeSupportScore ?? null,
  };
}

async function sendNewSignal(bot, chatId, candidate) {
  if (!bot || !chatId) return null;

  const text = buildSignalMessage(candidate);
  const replyMarkup = buildSignalReplyMarkup(candidate);

  return bot.sendMessage(chatId, text, {
    reply_markup: replyMarkup,
    disable_web_page_preview: true,
  });
}

async function sendScoreRise(bot, chatId, previous, current) {
  if (!bot || !chatId || !previous?.messageId) return null;

  const text = buildScoreRisingMessage({
    pair: current.pair,
    baseTf: current.baseTimeframe,
    oldScore: previous.score,
    newScore: current.score,
    updates: current.reasons?.slice(0, 4) || [],
  });

  return bot.sendMessage(chatId, text, {
    reply_to_message_id: previous.messageId,
  });
}

function dedupeCandidates(candidates) {
  const byKey = new Map();
  for (const raw of candidates || []) {
    const candidate = normalizeCandidate(raw);
    if (!candidate) continue;
    const key = buildSignalKey(candidate);
    const existing = byKey.get(key);
    if (!existing || Number(candidate.score || 0) > Number(existing.score || 0)) {
      byKey.set(key, candidate);
    }
  }
  return [...byKey.values()].sort((a, b) => Number(b.score || 0) - Number(a.score || 0));
}

async function dispatchSignals(bot, chatId, candidates) {
  const deduped = dedupeCandidates(candidates);
  if (!deduped.length) return [];

  const activeSignals = state.readJson(config.activeSignalsPath, {});
  const results = [];

  for (const candidate of deduped) {
    const signalKey = buildSignalKey(candidate);
    const band = getBand(candidate.score);
    const previous = activeSignals[signalKey];

    if (!previous) {
      if (!dryrun.canOpenNewSignal()) {
        continue;
      }

      const tracked = dryrun.registerSignal({
        ...candidate,
        signalKey,
      });
      if (!tracked) continue;

      const sent = await sendNewSignal(bot, chatId, candidate);
      dryrun.attachSignalMessage(tracked.signalId || tracked.id, sent?.message_id || null, signalKey);

      activeSignals[signalKey] = {
        ...candidate,
        band,
        messageId: sent?.message_id || null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };

      results.push({ type: "new", key: signalKey, candidate });
      continue;
    }

    const scoreRise = Number(candidate.score || 0) - Number(previous.score || 0);
    const raisedBand = bandRank(band) > bandRank(previous.band);

    if (scoreRise > 0 && (raisedBand || scoreRise >= config.scoreRiseThreshold)) {
      await sendScoreRise(bot, chatId, previous, candidate);
      activeSignals[signalKey] = {
        ...previous,
        ...candidate,
        band,
        updatedAt: new Date().toISOString(),
      };
      results.push({ type: "rise", key: signalKey, candidate });
      continue;
    }

    activeSignals[signalKey] = {
      ...previous,
      ...candidate,
      band: previous.band || band,
      updatedAt: previous.updatedAt || new Date().toISOString(),
    };
  }

  state.writeJson(config.activeSignalsPath, activeSignals);
  return results;
}

async function dispatchTradeUpdates(bot, chatId, updates) {
  if (!bot || !chatId || !Array.isArray(updates) || !updates.length) return [];

  const activeSignals = state.readJson(config.activeSignalsPath, {});
  const sent = [];
  let dirty = false

  for (const update of updates) {
    const position = update.position || update;
    const replyTo = position.signalMessageId || position.messageId || null;

    let text = "";
    if (update.type === "TARGET ACHIEVED 1" || update.type === "TARGET ACHIEVED 2") {
      text = buildTargetHitMessage(position, update.type);
    } else if (update.type === "SL1" || update.type === "SL2") {
      text = buildStopHitMessage(position, update.type);
    } else {
      continue;
    }

    const message = await bot.sendMessage(
      chatId,
      text,
      replyTo ? { reply_to_message_id: replyTo } : {}
    );
    sent.push(message);

    const signalKey = position.signalKey || buildSignalKey(position);
    if (
      activeSignals[signalKey] &&
      (!position.signalMessageId || activeSignals[signalKey].messageId === position.signalMessageId)
    ) {
      delete activeSignals[signalKey];
      dirty = true;
    }
  }

  if (dirty) {
    state.writeJson(config.activeSignalsPath, activeSignals);
  }

  return sent;
}

module.exports = {
  buildSignalCandidate,
  dispatchSignals,
  dispatchTradeUpdates,
  buildSignalKey,
  dedupeCandidates,
};
