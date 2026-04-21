const { round } = require("./indicators");

function buildBinancePairLink(pair) {
  return `https://www.binance.com/en/futures/${String(pair || "").toUpperCase()}`;
}

function formatPrice(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return "N/A";
  if (Math.abs(num) >= 1000) return num.toFixed(2);
  if (Math.abs(num) >= 1) return num.toFixed(4);
  return num.toFixed(6);
}

function formatScore(value) {
  const num = Number(value);
  return Number.isFinite(num) ? round(num, 2) : "N/A";
}

function formatRatio(value) {
  const num = Number(value);
  return Number.isFinite(num) ? `${round(num, 2)}R` : "N/A";
}

function formatPct(value, digits = 2) {
  const num = Number(value);
  return Number.isFinite(num) ? `${round(num, digits)}%` : "N/A";
}

function sideEmoji(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "🔴" : "🟢";
}

function sideWord(side) {
  return String(side || "").toUpperCase() === "SHORT" ? "SHORT" : "LONG";
}

function buildSignalMessage(candidate) {
  const side = sideWord(candidate.side);
  const emoji = sideEmoji(side);
  const reasons = Array.isArray(candidate.reasons) ? candidate.reasons.slice(0, 4) : [];
  const supportTfs = candidate.supportTfs || candidate.supportTimeframes || [];

  return [
    `${emoji} ${side} SIGNAL`,
    `🪙 Pair: ${candidate.pair}`,
    `🌐 Binance: ${buildBinancePairLink(candidate.pair)}`,
    `⏱ Base TF: ${candidate.baseTimeframe || candidate.baseTf || "N/A"}`,
    `📚 Support TFs (${supportTfs.length}): ${supportTfs.join(", ") || "N/A"}`,
    `🎯 Score: ${formatScore(candidate.score)}`,
    `💵 Entry Price: ${formatPrice(candidate.entry)}`,
    `✅ Target 1 (0.2%): ${formatPrice(candidate.target1Price)}`,
    `✅ Target 2 (Adjusted TP1): ${formatPrice(candidate.target2Price)}`,
    `❌ SL1 (0.2%): ${formatPrice(candidate.sl1Price)}`,
    `❌ SL2 (Adjusted SL): ${formatPrice(candidate.sl2Price)}`,
    `📌 TP3 (ignored in stats): ${formatPrice(candidate.ignoredTp3)}`,
    `📌 TP4 (ignored in stats): ${formatPrice(candidate.ignoredTp4)}`,
    `⚖️ Risk/Reward: ${formatRatio(candidate.riskReward)}`,
    `🧠 Strategy Source: ${candidate.strategyUsed || candidate.strategySource || "N/A"}`,
    reasons.length ? `✅ Conditions: ${reasons.join(" | ")}` : "✅ Conditions: Matched learned setup",
    `ℹ️ Performance uses only Target 1, Target 2, SL1, and SL2. TP3 and TP4 are ignored for performance calculation.`,
  ].join("\n");
}

function buildSignalReplyMarkup(candidate) {
  return {
    inline_keyboard: [[
      {
        text: "📈 Open on Binance",
        url: buildBinancePairLink(candidate.pair),
      },
    ]],
  };
}

function buildScoreRisingMessage({ pair, baseTf, oldScore, newScore, updates = [] }) {
  return [
    `🚀 Score Increased for ${pair}`,
    `⏱ TF: ${baseTf || "N/A"}`,
    `📈 Score: ${formatScore(oldScore)} → ${formatScore(newScore)}`,
    updates.length ? `✅ Updates: ${updates.join(" | ")}` : null,
  ].filter(Boolean).join("\n");
}

function buildTargetHitMessage(position, targetType) {
  const isTwo = String(targetType).toUpperCase().includes("2");
  const title = isTwo ? "✅ TARGET ACHIEVED 2" : "✅ TARGET ACHIEVED 1";
  const targetPrice = isTwo ? position.target2Price : position.target1Price;
  const pnlAmount = isTwo ? position.pnl2PnlAmount : position.pnl1PnlAmount;
  const pnlPct = isTwo ? position.pnl2PnlPct : position.pnl1PnlPct;

  return [
    title,
    `🪙 Pair: ${position.pair}`,
    `📍 Side: ${position.side}`,
    `⏱ Base TF: ${position.baseTimeframe}`,
    `💵 Entry: ${formatPrice(position.entryPrice || position.entry)}`,
    `🏁 Exit Target: ${formatPrice(targetPrice)}`,
    `📌 Current Mark: ${formatPrice(position.currentMark)}`,
    `💹 Model PNL: ${formatPrice(pnlAmount)} (${formatPct(pnlPct)})`,
  ].join("\n");
}

function buildStopHitMessage(position, stopType) {
  const isTwo = String(stopType).toUpperCase().includes("2");
  const title = isTwo ? "❌ SL2 HIT" : "❌ SL1 HIT";
  const stopPrice = isTwo ? position.sl2Price : position.sl1Price;
  const pnlAmount = isTwo ? position.pnl2PnlAmount : position.pnl1PnlAmount;
  const pnlPct = isTwo ? position.pnl2PnlPct : position.pnl1PnlPct;

  return [
    title,
    `🪙 Pair: ${position.pair}`,
    `📍 Side: ${position.side}`,
    `⏱ Base TF: ${position.baseTimeframe}`,
    `💵 Entry: ${formatPrice(position.entryPrice || position.entry)}`,
    `🧯 Stop Price: ${formatPrice(stopPrice)}`,
    `📌 Exit Mark: ${formatPrice(position.currentMark)}`,
    `💥 Model PNL: ${formatPrice(pnlAmount)} (${formatPct(pnlPct)})`,
  ].join("\n");
}

module.exports = {
  buildBinancePairLink,
  buildSignalMessage,
  buildSignalReplyMarkup,
  buildScoreRisingMessage,
  buildTargetHitMessage,
  buildStopHitMessage,
};
