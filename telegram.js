const TelegramBot = require("node-telegram-bot-api");
const config = require("./config");
const { getWatchedPairs, saveWatchedPairs, getAllowedPairs } = require("./state");
const {
  loadStrategiesIndex,
  getStrategyByPair,
  rebuildStrategiesIndexFromFiles,
} = require("./strategyLearner");
const dryrun = require("./dryrun");

const COMMANDS = [
  { command: "start", description: "Open menu" },
  { command: "help", description: "Show commands" },
  { command: "pairs", description: "Show watched pairs" },
  { command: "addpair", description: "Add pair. Example: /addpair BTCUSDT" },
  { command: "removepair", description: "Remove pair. Example: /removepair BTCUSDT" },
  { command: "scan", description: "Run scan now" },
  { command: "dryrun", description: "Show dry-run summary" },
  { command: "pnl", description: "Show combined PNL summary" },
  { command: "pnl1", description: "Show PNL1 stats" },
  { command: "pnl2", description: "Show PNL2 stats" },
  { command: "signals", description: "Show active monitored signals" },
  { command: "closed", description: "Show fully closed trades" },
  { command: "dryrunlong", description: "Open dry-run LONG tests" },
  { command: "dryrunshort", description: "Open dry-run SHORT tests" },
  { command: "strategies", description: "Show saved strategy count" },
  { command: "strategylist", description: "List saved strategies" },
  { command: "strategy", description: "Show detailed strategy" },
  { command: "rebuildstrategies", description: "Rebuild strategy index from files" },
];

function createBot() {
  if (!config.telegramBotToken) {
    console.error("Missing TELEGRAM_BOT_TOKEN in .env");
    return null;
  }

  return new TelegramBot(config.telegramBotToken, {
    polling: config.telegramPolling,
  });
}

async function setupCommands(bot) {
  if (!bot) return;

  try {
    await bot.setMyCommands(COMMANDS);
    console.log("Telegram commands registered.");
  } catch (error) {
    console.error("Failed to register Telegram commands:", error.message);
  }
}

function commandRegex(command, withArg = false) {
  return withArg
    ? new RegExp(`^/${command}(?:@\\w+)?\\s+(.+)$`, "i")
    : new RegExp(`^/${command}(?:@\\w+)?$`, "i");
}

function splitLongMessage(text, chunkSize = 3500) {
  const lines = String(text).split("\n");
  const chunks = [];
  let current = "";

  for (const line of lines) {
    if ((current + "\n" + line).length > chunkSize) {
      if (current.trim()) chunks.push(current.trim());
      current = line;
    } else {
      current += `${current ? "\n" : ""}${line}`;
    }
  }

  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

function buildHelpText() {
  return [
    "🤖 Binance Futures Pump Scanner",
    "",
    "Rules active:",
    "• Only pairs present in pair.js are scanned.",
    `• New alerts only when score > ${config.notifyMinScore}.`,
    `• Base timeframe allowed: ${config.allowedBaseTimeframes.join(", ")}.`,
    `• Minimum support confirmations: ${config.minSupportCount} including self TF.`,
    "• Only one blocking signal at a time. A new signal is allowed after PNL1 or PNL2 closes, while the other model keeps monitoring.",
    "",
    "/start - open menu",
    "/help - show commands",
    "/pairs - show watched pairs",
    "/addpair BTCUSDT - add pair if it exists in pair.js",
    "/removepair BTCUSDT - remove pair from active scan list",
    "/scan - run scan now",
    "/dryrun - dry-run summary",
    "/pnl - combined PNL summary",
    "/pnl1 - PNL1 stats",
    "/pnl2 - PNL2 stats",
    "/signals - show active monitored signals",
    "/closed - show fully closed trades",
    "/dryrunlong - create dry-run LONG tests",
    "/dryrunshort - create dry-run SHORT tests",
    "/strategies - show saved strategy count",
    "/strategylist - list saved strategies",
    "/strategy BTCUSDT - show saved strategy in detail",
    "/rebuildstrategies - rebuild strategy index from files",
  ].join("\n");
}

function buildMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        ["/pairs", "/scan"],
        ["/dryrun", "/pnl"],
        ["/pnl1", "/pnl2"],
        ["/signals", "/closed"],
        ["/dryrunlong", "/dryrunshort"],
        ["/strategies", "/strategylist"],
        ["/help"],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
    },
  };
}

function formatStrategyTimeframes(strategy) {
  const details = strategy.allTimeframes || {};
  const timeframes = Object.keys(details);

  if (!timeframes.length) {
    return "No all-timeframe snapshot saved.";
  }

  return timeframes
    .map((tf) => {
      const row = details[tf] || {};
      return [
        `⏱ ${tf}`,
        `trend=${row.trend ?? "n/a"}`,
        `bullBos=${row.bullishBos ?? "n/a"}`,
        `bearBos=${row.bearishBos ?? "n/a"}`,
        `bbPct=${row.bbWidthPercentile ?? "n/a"}`,
        `macd=${row.macdLine ?? "n/a"}`,
        `signal=${row.macdSignal ?? "n/a"}`,
        `hist=${row.macdHistogram ?? "n/a"}`,
        `adx=${row.adx ?? "n/a"}`,
        `vol20=${row.volumeVsAvg20 ?? "n/a"}`,
        `qVol20=${row.quoteVolumeVsAvg20 ?? "n/a"}`,
        `oiChg=${row.openInterestChangePct ?? "n/a"}`,
        `taker=${row.takerBuySellRatio ?? "n/a"}`,
        `funding=${row.fundingRate ?? "n/a"}`,
        `close=${row.currentClose ?? "n/a"}`,
      ].join(" | ");
    })
    .join("\n");
}

function formatStrategyMessage(strategy) {
  const trigger = strategy.triggerFeatures || {};
  const flow = strategy.flowFeatures || {};

  const text = [
    `🧠 Strategy for ${strategy.pair}`,
    `Direction: ${strategy.direction}`,
    `Event Time: ${strategy.eventTime}`,
    `Main Source TF: ${strategy.mainSourceTimeframe || "N/A"}`,
    `Saved TFs: ${(strategy.savedTimeframes || []).join(", ") || "N/A"}`,
    `Supporting TFs: ${(strategy.supportingTimeframes || []).join(", ") || "N/A"}`,
    `Expansion: ${strategy.resultingExpansionPct}%`,
    `Pump Window: ${strategy.sourcePumpWindow?.startIndex ?? "n/a"} -> ${strategy.sourcePumpWindow?.endIndex ?? "n/a"}`,
    "",
    "📌 Trigger Features",
    `BB Width Percentile: ${trigger.bbWidthPercentile ?? "n/a"}`,
    `BB Width: ${trigger.bbWidth ?? "n/a"}`,
    `MACD Line: ${trigger.macdLine ?? "n/a"}`,
    `MACD Signal: ${trigger.macdSignal ?? "n/a"}`,
    `MACD Histogram: ${trigger.macdHistogram ?? "n/a"}`,
    `MACD Hist Slope: ${trigger.macdHistogramSlope ?? "n/a"}`,
    `MACD Bull Cross: ${trigger.macdBullCross ?? "n/a"}`,
    `MACD Bear Cross: ${trigger.macdBearCross ?? "n/a"}`,
    `MACD Above Zero: ${trigger.macdAboveZero ?? "n/a"}`,
    `MACD Below Zero: ${trigger.macdBelowZero ?? "n/a"}`,
    `ADX: ${trigger.adx ?? "n/a"}`,
    `ADX Slope: ${trigger.adxSlope ?? "n/a"}`,
    `DI Spread: ${trigger.diSpread ?? "n/a"}`,
    `Volume/Avg20: ${trigger.volumeVsAvg20 ?? "n/a"}`,
    `Volume/Avg50: ${trigger.volumeVsAvg50 ?? "n/a"}`,
    `QuoteVol/Avg20: ${trigger.quoteVolumeVsAvg20 ?? "n/a"}`,
    `Bullish BOS: ${trigger.bullishBos ?? "n/a"}`,
    `Bearish BOS: ${trigger.bearishBos ?? "n/a"}`,
    `Trend: ${trigger.trend ?? "n/a"}`,
    `Support: ${trigger.support ?? "n/a"}`,
    `Resistance: ${trigger.resistance ?? "n/a"}`,
    "",
    "🌊 Flow Features",
    `Funding Rate: ${flow.fundingRate ?? "n/a"}`,
    `Open Interest: ${flow.openInterest ?? "n/a"}`,
    `OI Change %: ${flow.openInterestChangePct ?? "n/a"}`,
    `Taker Buy/Sell Ratio: ${flow.takerBuySellRatio ?? "n/a"}`,
    "",
    "📝 Explanation",
    strategy.reusableStrategyExplanation || "No explanation stored.",
    "",
    "📚 Saved All-Timeframe Snapshot",
    formatStrategyTimeframes(strategy),
  ].join("\n");

  return splitLongMessage(text);
}

function summarizeDryrunInsert(results, side) {
  const added = results.filter(Boolean);
  if (!added.length) {
    return `No ${side} candidates were opened. Either nothing qualified or a blocking signal is still active.`;
  }

  const lines = added.slice(0, 30).map(
    (c) => `${c.pair} | ${c.baseTimeframe} | score ${c.score} | pnl1=${c.pnl1Status} | pnl2=${c.pnl2Status}`
  );

  return [
    `🧪 ${side} dry-run added`,
    `Positions opened: ${added.length}`,
    "",
    ...lines,
  ].join("\n");
}

function formatModelSummary(label, summary) {
  return [
    `${label}`,
    `Total Signals: ${summary.totalSignals}`,
    `${label === "PNL1" ? "Target Achieved 1" : "Target Achieved 2"} Count: ${summary.targetCount}`,
    `${label === "PNL1" ? "SL1" : "SL2"} Count: ${summary.slCount}`,
    `${label} Win Rate: ${summary.winRate}%`,
    `${label} Loss Rate: ${summary.lossRate}%`,
    `${label} Cumulative P/L: ${summary.cumulativeProfitLoss}`,
  ].join("\n");
}

function registerHandlers(bot, callbacks) {
  if (!bot) return;

  bot.onText(commandRegex("start"), async (msg) => {
    await bot.sendMessage(
      msg.chat.id,
      `✅ Bot is online.\n\n${buildHelpText()}`,
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("help"), async (msg) => {
    await bot.sendMessage(msg.chat.id, buildHelpText(), buildMainMenu());
  });

  bot.onText(commandRegex("pairs"), async (msg) => {
    const pairs = getWatchedPairs();
    await bot.sendMessage(
      msg.chat.id,
      pairs.length
        ? `📋 Active scanned pairs (${pairs.length})\n${pairs.join(", ")}\n\nAllowed from pair.js: ${getAllowedPairs().join(", ")}`
        : "No watched pairs found.",
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("addpair", true), async (msg, match) => {
    const pair = String(match[1] || "").trim().toUpperCase();
    if (!pair) {
      await bot.sendMessage(msg.chat.id, "Send like: /addpair BTCUSDT", buildMainMenu());
      return;
    }

    if (!getAllowedPairs().includes(pair)) {
      await bot.sendMessage(
        msg.chat.id,
        `❌ ${pair} is not in pair.js, so it cannot be scanned.`,
        buildMainMenu()
      );
      return;
    }

    const pairs = getWatchedPairs();
    if (!pairs.includes(pair)) {
      pairs.push(pair);
      saveWatchedPairs(pairs);
      await bot.sendMessage(msg.chat.id, `✅ Added ${pair}`, buildMainMenu());
      return;
    }

    await bot.sendMessage(msg.chat.id, `ℹ️ ${pair} already exists`, buildMainMenu());
  });

  bot.onText(commandRegex("removepair", true), async (msg, match) => {
    const pair = String(match[1] || "").trim().toUpperCase();
    const next = getWatchedPairs().filter((item) => item !== pair);
    saveWatchedPairs(next);
    await bot.sendMessage(msg.chat.id, `🗑 Removed ${pair}`, buildMainMenu());
  });

  bot.onText(commandRegex("scan"), async (msg) => {
    await bot.sendMessage(msg.chat.id, "🔎 Running manual scan...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
    });

    const text = [
      "✅ Scan done",
      `Pairs checked: ${summary.pairsChecked || 0}`,
      `Candidates: ${summary.candidates || 0}`,
      `Learned strategies: ${summary.learnedStrategies || 0}`,
      summary.error ? `Error: ${summary.error}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    await bot.sendMessage(msg.chat.id, text, buildMainMenu());
  });

  bot.onText(commandRegex("dryrun"), async (msg) => {
    const summary = dryrun.pnlSummary();
    await bot.sendMessage(
      msg.chat.id,
      [
        "🧪 Dry-run Summary",
        `Open/Monitoring Trades: ${summary.openCount}`,
        `Fully Closed Trades: ${summary.closedCount}`,
        `Blocking Signals: ${summary.blockingSignals}`,
        `Background Monitoring: ${summary.backgroundMonitoring}`,
        `Open Unrealized PNL: ${summary.openUnrealized}`,
        `Combined Realized PNL: ${summary.realized}`,
        "",
        formatModelSummary("PNL1", summary.pnl1),
        "",
        formatModelSummary("PNL2", summary.pnl2),
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("pnl"), async (msg) => {
    const summary = dryrun.pnlSummary();
    await bot.sendMessage(
      msg.chat.id,
      [
        "💹 Combined PNL Summary",
        `Blocking Signals: ${summary.blockingSignals}`,
        `Background Monitoring: ${summary.backgroundMonitoring}`,
        `Open Unrealized: ${summary.openUnrealized}`,
        `Combined Realized: ${summary.realized}`,
        "",
        formatModelSummary("PNL1", summary.pnl1),
        "",
        formatModelSummary("PNL2", summary.pnl2),
      ].join("\n"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("pnl1"), async (msg) => {
    const summary = dryrun.pnlModelSummary("pnl1");
    await bot.sendMessage(msg.chat.id, `📊 PNL1 Stats\n${formatModelSummary("PNL1", summary)}`, buildMainMenu());
  });

  bot.onText(commandRegex("pnl2"), async (msg) => {
    const summary = dryrun.pnlModelSummary("pnl2");
    await bot.sendMessage(msg.chat.id, `📊 PNL2 Stats\n${formatModelSummary("PNL2", summary)}`, buildMainMenu());
  });

  bot.onText(commandRegex("dryrunlong"), async (msg) => {
    await bot.sendMessage(msg.chat.id, "🧪 Building LONG dry-run tests...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const longCandidates = (summary.topCandidates || []).filter((c) => c.side === "LONG");
    const added = longCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await bot.sendMessage(
      msg.chat.id,
      summarizeDryrunInsert(added, "LONG"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("dryrunshort"), async (msg) => {
    await bot.sendMessage(msg.chat.id, "🧪 Building SHORT dry-run tests...");
    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const shortCandidates = (summary.topCandidates || []).filter((c) => c.side === "SHORT");
    const added = shortCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await bot.sendMessage(
      msg.chat.id,
      summarizeDryrunInsert(added, "SHORT"),
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("signals"), async (msg) => {
    const open = dryrun.loadOpenPositions();
    if (!open.length) {
      await bot.sendMessage(msg.chat.id, "No active monitored trades.", buildMainMenu());
      return;
    }

    const text = open
      .slice(0, 20)
      .map(
        (p) =>
          `${p.pair} ${p.side} | ${p.baseTimeframe} | gate=${p.blocksNewSignals ? "BLOCKED" : "FREE"} | pnl1=${p.pnl1Status} | pnl2=${p.pnl2Status} | mark=${p.currentMark}`
      )
      .join("\n");

    await bot.sendMessage(msg.chat.id, `📡 Monitored Trades\n${text}`, buildMainMenu());
  });

  bot.onText(commandRegex("closed"), async (msg) => {
    const closed = dryrun.loadClosedTrades().slice(-20).reverse();
    if (!closed.length) {
      await bot.sendMessage(msg.chat.id, "No fully closed trades.", buildMainMenu());
      return;
    }

    const text = closed
      .map(
        (p) =>
          `${p.pair} ${p.side} | pnl1=${p.pnl1Status} | pnl2=${p.pnl2Status} | realized=${p.realizedPnl}`
      )
      .join("\n");

    await bot.sendMessage(msg.chat.id, `📦 Fully Closed Trades\n${text}`, buildMainMenu());
  });

  bot.onText(commandRegex("strategies"), async (msg) => {
    const index = loadStrategiesIndex();
    await bot.sendMessage(
      msg.chat.id,
      `🧠 Saved learned strategies: ${index.length}`,
      buildMainMenu()
    );
  });

  bot.onText(commandRegex("strategylist"), async (msg) => {
    const index = loadStrategiesIndex().slice(0, 100);

    if (!index.length) {
      await bot.sendMessage(msg.chat.id, "No saved strategies yet.", buildMainMenu());
      return;
    }

    const text = index
      .map(
        (s) =>
          `${s.pair} | ${s.direction} | ${s.eventTime} | mainTF=${s.mainSourceTimeframe || "n/a"} | savedTFs=${(s.savedTimeframes || []).join(",")} | supportTFs=${(s.supportingTimeframes || []).join(",")}`
      )
      .join("\n");

    for (const chunk of splitLongMessage(`🗂 Strategy List\n${text}`)) {
      await bot.sendMessage(msg.chat.id, chunk, buildMainMenu());
    }
  });

  bot.onText(commandRegex("strategy", true), async (msg, match) => {
    const pair = String(match[1] || "").trim().toUpperCase();
    const strategiesForPair = getStrategyByPair(pair);

    if (!strategiesForPair.length) {
      await bot.sendMessage(msg.chat.id, `No strategy saved for ${pair}`, buildMainMenu());
      return;
    }

    for (const strategy of strategiesForPair.slice(0, 20)) {
      const chunks = formatStrategyMessage(strategy);
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, buildMainMenu());
      }
    }
  });

  bot.onText(commandRegex("rebuildstrategies"), async (msg) => {
    const rebuilt = rebuildStrategiesIndexFromFiles();
    await bot.sendMessage(
      msg.chat.id,
      `♻️ Strategy index rebuilt.\nTotal strategies indexed: ${rebuilt.length}`,
      buildMainMenu()
    );
  });

  bot.on("polling_error", (error) => {
    console.error("Telegram polling error:", error.message);
  });
}

module.exports = {
  createBot,
  setupCommands,
  registerHandlers,
  buildHelpText,
};
