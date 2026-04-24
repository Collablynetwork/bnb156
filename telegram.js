const TelegramBot = require("node-telegram-bot-api");
const fs = require("fs");
const path = require("path");
const config = require("./config");
const state = require("./state");
const dryrun = require("./dryrun");

let strategyLearner = null;
try {
  strategyLearner = require("./strategyLearner");
} catch (e) {
  strategyLearner = null;
}

const COMMANDS = [
  { command: "start", description: "Open professional menu" },
  { command: "help", description: "Show help" },
  { command: "menu", description: "Open main menu" },
  { command: "pairs", description: "Show watched pairs" },
  { command: "addpair", description: "Add pair. Example: /addpair BTCUSDT" },
  { command: "removepair", description: "Remove pair. Example: /removepair BTCUSDT" },
  { command: "scan", description: "Run scan now" },
  { command: "status", description: "Show scanner status" },
  { command: "pnl", description: "Show final PNL stats" },
  { command: "signals", description: "Show active monitored signals" },
  { command: "closed", description: "Show fully closed trades" },
  { command: "dryrun", description: "Show dry-run summary" },
  { command: "dryrunlong", description: "Open dry-run LONG tests" },
  { command: "dryrunshort", description: "Open dry-run SHORT tests" },
  { command: "strategies", description: "Show saved strategy count" },
  { command: "strategylist", description: "List saved strategies" },
  { command: "strategy", description: "Show detailed strategy for pair" },
  { command: "rebuildstrategies", description: "Rebuild strategy index from files" },
  { command: "clearalltradingstrategy", description: "Clear all saved strategies" },
  { command: "clearalltradingstatus", description: "Clear all trading status and PNL" },
  {
    command: "activesignalslot",
    description: "Set active signal slots. Example: /activesignalslot 2",
  },
  {
    command: "strategyretentionhour",
    description: "Set strategy retention. Example: /strategyretentionhour 4h",
  },
];

const BUTTONS = {
  STATUS: "📊 Status",
  PAIRS: "👀 Pairs",
  SCAN: "🔎 Scan Now",
  PNL: "💹 PNL",
  SIGNALS: "📡 Signals",
  CLOSED: "📦 Closed Trades",
  DRYRUN: "🧪 Dryrun",
  DRYRUN_LONG: "🟢 Dryrun Long",
  DRYRUN_SHORT: "🔴 Dryrun Short",
  STRATEGIES: "🧠 Strategies",
  STRATEGY_LIST: "🗂 Strategy List",
  REBUILD_STRATEGIES: "♻️ Rebuild Strategies",
  CLEAR_STATUS: "🧹 Clear Trading Status",
  CLEAR_STRATEGIES: "🗑 Clear Trading Strategy",
  ACTIVE_SLOTS: "🎛 Signal Slots",
  RETENTION: "⏱ Strategy Retention",
  HELP: "❓ Help",
  MENU: "🏠 Main Menu",
};

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

function isButtonText(text, buttonText) {
  return String(text || "").trim() === buttonText;
}

function splitLongMessage(text, chunkSize = 3500) {
  const lines = String(text || "").split("\n");
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

function parseRetentionHours(input) {
  const raw = String(input || "").trim().toLowerCase();

  if (!raw) return null;

  const match = raw.match(/^(\d+(?:\.\d+)?)\s*h$/i);
  if (!match) return null;

  const hours = Number(match[1]);
  if (!Number.isFinite(hours) || hours <= 0) return null;

  return hours;
}

function parsePositiveInt(input) {
  const raw = String(input || "").trim();
  if (!raw) return null;
  if (!/^\d+$/.test(raw)) return null;

  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return Math.floor(parsed);
}

function loadRuntimeSettings() {
  const runtimeSettings =
    typeof state.getRuntimeSettings === "function" ? state.getRuntimeSettings() : {};
  return {
    strategyRetentionHours: Number(
      runtimeSettings.strategyRetentionHours || config.defaultStrategyRetentionHours || 4
    ),
    activeSignalSlots: Math.max(1, Math.floor(Number(runtimeSettings.activeSignalSlots || 1))),
    updatedAt: runtimeSettings.updatedAt || null,
  };
}

function saveRuntimeSettings(nextSettings) {
  if (typeof state.saveRuntimeSettings === "function") {
    return state.saveRuntimeSettings(nextSettings);
  }

  const finalData = {
    strategyRetentionHours: Number(nextSettings.strategyRetentionHours || 4),
    activeSignalSlots: Math.max(1, Math.floor(Number(nextSettings.activeSignalSlots || 1))),
    updatedAt: new Date().toISOString(),
  };
  writeJsonSafe(config.runtimeSettingsPath, finalData);
  return finalData;
}

function getStrategyRetentionHours() {
  return Number(loadRuntimeSettings().strategyRetentionHours || 4);
}

function setStrategyRetentionHours(hours) {
  return saveRuntimeSettings({ strategyRetentionHours: hours });
}

function getActiveSignalSlots() {
  return Number(loadRuntimeSettings().activeSignalSlots || 1);
}

function setActiveSignalSlots(slots) {
  return saveRuntimeSettings({ activeSignalSlots: slots });
}

function getStrategyFiles() {
  const dir = config.strategiesDir;
  try {
    if (!dir || !fs.existsSync(dir)) return [];
    return fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".json") && name !== "index.json")
      .map((name) => path.join(dir, name));
  } catch (error) {
    console.error("getStrategyFiles error:", error.message);
    return [];
  }
}

function readJsonSafe(filePath, defaultValue) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const raw = fs.readFileSync(filePath, "utf8");
    return raw.trim() ? JSON.parse(raw) : defaultValue;
  } catch (error) {
    console.error(`readJsonSafe failed for ${filePath}:`, error.message);
    return defaultValue;
  }
}

function writeJsonSafe(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

function pruneStrategiesByRetentionHours(hours) {
  const retentionMs = Number(hours || 4) * 60 * 60 * 1000;
  const now = Date.now();

  const files = getStrategyFiles();
  let removedFiles = 0;

  for (const filePath of files) {
    const data = readJsonSafe(filePath, null);
    if (!data || typeof data !== "object") {
      try {
        fs.unlinkSync(filePath);
        removedFiles += 1;
      } catch (_) {}
      continue;
    }

    const eventTime = data.eventTime || data.timestamp || data.createdAt || data.savedAt || null;
    const timeMs = eventTime ? new Date(eventTime).getTime() : NaN;

    if (!Number.isFinite(timeMs) || now - timeMs > retentionMs) {
      try {
        fs.unlinkSync(filePath);
        removedFiles += 1;
      } catch (error) {
        console.error(`Failed to remove expired strategy file ${filePath}:`, error.message);
      }
    }
  }

  let filteredIndex = [];
  const currentIndex = readJsonSafe(config.strategiesIndexPath, []);
  if (Array.isArray(currentIndex)) {
    filteredIndex = currentIndex.filter((item) => {
      const eventTime =
        item?.eventTime || item?.timestamp || item?.createdAt || item?.savedAt || null;
      const timeMs = eventTime ? new Date(eventTime).getTime() : NaN;
      return Number.isFinite(timeMs) && now - timeMs <= retentionMs;
    });
  }

  writeJsonSafe(config.strategiesIndexPath, filteredIndex);

  return {
    removedFiles,
    remainingStrategies: filteredIndex.length,
    retentionHours: Number(hours || 4),
  };
}

function clearAllTradingStrategies() {
  let removedFiles = 0;

  for (const filePath of getStrategyFiles()) {
    try {
      fs.unlinkSync(filePath);
      removedFiles += 1;
    } catch (error) {
      console.error(`Failed to remove strategy file ${filePath}:`, error.message);
    }
  }

  writeJsonSafe(config.strategiesIndexPath, []);

  return {
    removedFiles,
    indexCleared: true,
  };
}

function clearAllTradingStatus() {
  const targets = [
    config.activeSignalsPath,
    config.dryRunPositionsPath,
    config.closedTradesPath,
    config.scoreStatePath,
    config.learnedPumpsPath,
  ];

  for (const filePath of targets) {
    if (!filePath) continue;

    const lower = String(filePath).toLowerCase();
    const defaultValue = lower.includes("positions") || lower.includes("trades") || lower.includes("pumps")
      ? []
      : {};

    writeJsonSafe(filePath, defaultValue);
  }

  return {
    cleared: true,
    files: targets.filter(Boolean).length,
  };
}

function buildHelpText() {
  const retention = getStrategyRetentionHours();
  const activeSlots = getActiveSignalSlots();

  return [
    "🤖 Professional Trading Control Panel",
    "",
    "Main updates active:",
    "• PNL1 removed",
    "• Only final PNL kept",
    "• Strategy retention works in hour format",
    "• Active signal slots can be changed from Telegram",
    "• Telegram menu buttons and slash commands both work",
    "",
    "Available commands:",
    "/start - open main menu",
    "/menu - open main menu",
    "/help - show help",
    "/status - show scanner status",
    "/pairs - show watched pairs",
    "/addpair BTCUSDT - add pair if it exists in pair.js",
    "/removepair BTCUSDT - remove pair from active scan list",
    "/scan - run manual scan",
    "/pnl - show final PNL stats",
    "/signals - show active monitored signals",
    "/closed - show fully closed trades",
    "/dryrun - dry-run summary",
    "/dryrunlong - create dry-run LONG tests",
    "/dryrunshort - create dry-run SHORT tests",
    "/strategies - show saved strategy count",
    "/strategylist - list saved strategies",
    "/strategy BTCUSDT - show detailed strategy",
    "/rebuildstrategies - rebuild strategy index from files",
    "/clearalltradingstrategy - clear all strategy files",
    "/clearalltradingstatus - clear all trading status and PNL data",
    `/activesignalslot ${activeSlots} - set concurrent active signal slots`,
    `/strategyretentionhour ${retention}h - set retention window`,
  ].join("\n");
}

function buildMainMenu() {
  return {
    reply_markup: {
      keyboard: [
        [BUTTONS.STATUS, BUTTONS.PAIRS, BUTTONS.SCAN],
        [BUTTONS.PNL, BUTTONS.SIGNALS, BUTTONS.CLOSED],
        [BUTTONS.DRYRUN, BUTTONS.DRYRUN_LONG, BUTTONS.DRYRUN_SHORT],
        [BUTTONS.STRATEGIES, BUTTONS.STRATEGY_LIST, BUTTONS.REBUILD_STRATEGIES],
        [BUTTONS.CLEAR_STATUS, BUTTONS.CLEAR_STRATEGIES],
        [BUTTONS.RETENTION, BUTTONS.ACTIVE_SLOTS, BUTTONS.HELP],
        [BUTTONS.MENU],
      ],
      resize_keyboard: true,
      one_time_keyboard: false,
      selective: false,
      input_field_placeholder: "Choose an action from the control panel",
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
    (c) => `${c.pair} | ${c.baseTimeframe} | score ${c.score} | pnl=${c.pnl2Status || c.pnlStatus || "OPEN"}`
  );

  return [
    `🧪 ${side} dry-run added`,
    `Positions opened: ${added.length}`,
    "",
    ...lines,
  ].join("\n");
}

function formatFinalPnlSummary(summary) {
  return [
    "💹 Final PNL Summary",
    `Total Signals: ${summary.totalSignals || 0}`,
    `Target Count: ${summary.targetCount || 0}`,
    `SL Count: ${summary.slCount || 0}`,
    `Win Rate: ${summary.winRate || 0}%`,
    `Loss Rate: ${summary.lossRate || 0}%`,
    `Cumulative P/L: ${summary.cumulativeProfitLoss || 0}`,
  ].join("\n");
}

async function sendWithMenu(bot, chatId, text) {
  const chunks = splitLongMessage(text);
  for (const chunk of chunks) {
    await bot.sendMessage(chatId, chunk, buildMainMenu());
  }
}

function getStrategiesIndex() {
  if (strategyLearner && typeof strategyLearner.loadStrategiesIndex === "function") {
    return strategyLearner.loadStrategiesIndex();
  }
  return readJsonSafe(config.strategiesIndexPath, []);
}

function getStrategyByPair(pair) {
  if (strategyLearner && typeof strategyLearner.getStrategyByPair === "function") {
    return strategyLearner.getStrategyByPair(pair);
  }

  const files = getStrategyFiles();
  const target = String(pair || "").trim().toUpperCase();

  return files
    .map((filePath) => readJsonSafe(filePath, null))
    .filter((item) => item && String(item.pair || "").toUpperCase() === target);
}

function rebuildStrategiesIndexFromFiles() {
  if (strategyLearner && typeof strategyLearner.rebuildStrategiesIndexFromFiles === "function") {
    return strategyLearner.rebuildStrategiesIndexFromFiles();
  }

  const files = getStrategyFiles();
  const rebuilt = files
    .map((filePath) => readJsonSafe(filePath, null))
    .filter(Boolean)
    .map((s) => ({
      pair: s.pair || "N/A",
      direction: s.direction || "N/A",
      eventTime: s.eventTime || s.timestamp || s.createdAt || s.savedAt || null,
      mainSourceTimeframe: s.mainSourceTimeframe || "n/a",
      savedTimeframes: s.savedTimeframes || [],
      supportingTimeframes: s.supportingTimeframes || [],
    }));

  writeJsonSafe(config.strategiesIndexPath, rebuilt);
  return rebuilt;
}

function registerHandlers(bot, callbacks) {
  if (!bot) return;

  async function actionStart(msg) {
    await bot.sendMessage(
      msg.chat.id,
      `✅ Bot is online.\n\n${buildHelpText()}`,
      buildMainMenu()
    );
  }

  async function actionHelp(msg) {
    await sendWithMenu(bot, msg.chat.id, buildHelpText());
  }

  async function actionStatus(msg) {
    const retentionHours = getStrategyRetentionHours();
    const activeSlots = getActiveSignalSlots();
    const watched = state.getWatchedPairs ? state.getWatchedPairs() : [];
    const strategies = getStrategiesIndex();

    const summary = dryrun && typeof dryrun.pnlSummary === "function"
      ? dryrun.pnlSummary()
      : {
          openCount: 0,
          closedCount: 0,
          blockingSignals: 0,
          backgroundMonitoring: 0,
          openUnrealized: 0,
          realized: 0,
        };

    await sendWithMenu(
      bot,
      msg.chat.id,
      [
        "📊 Scanner Status",
        `Watched Pairs: ${watched.length}`,
        `Saved Strategies: ${strategies.length}`,
        `Strategy Retention: ${retentionHours}h`,
        `Active Signal Slots: ${activeSlots}`,
        `Used Signal Slots: ${summary.blockingSignals || 0}/${activeSlots}`,
        `Open/Monitoring Trades: ${summary.openCount || 0}`,
        `Closed Trades: ${summary.closedCount || 0}`,
        `Blocking Signals: ${summary.blockingSignals || 0}`,
        `Background Monitoring: ${summary.backgroundMonitoring || 0}`,
        `Open Unrealized PNL: ${summary.openUnrealized || 0}`,
        `Realized PNL: ${summary.realized || 0}`,
      ].join("\n")
    );
  }

  async function actionPairs(msg) {
    const pairs = state.getWatchedPairs ? state.getWatchedPairs() : [];
    const allowed = state.getAllowedPairs ? state.getAllowedPairs() : [];

    await sendWithMenu(
      bot,
      msg.chat.id,
      pairs.length
        ? `👀 Active scanned pairs (${pairs.length})\n${pairs.join(", ")}\n\nAllowed from pair.js:\n${allowed.join(", ")}`
        : "No watched pairs found."
    );
  }

  async function actionAddPair(msg, pair) {
    const symbol = String(pair || "").trim().toUpperCase();

    if (!symbol) {
      await sendWithMenu(bot, msg.chat.id, "Send like: /addpair BTCUSDT");
      return;
    }

    if (!state.getAllowedPairs || !state.getAllowedPairs().includes(symbol)) {
      await sendWithMenu(bot, msg.chat.id, `❌ ${symbol} is not in pair.js, so it cannot be scanned.`);
      return;
    }

    const pairs = state.getWatchedPairs ? state.getWatchedPairs() : [];
    if (!pairs.includes(symbol)) {
      pairs.push(symbol);
      if (state.saveWatchedPairs) state.saveWatchedPairs(pairs);
      await sendWithMenu(bot, msg.chat.id, `✅ Added ${symbol}`);
      return;
    }

    await sendWithMenu(bot, msg.chat.id, `ℹ️ ${symbol} already exists`);
  }

  async function actionRemovePair(msg, pair) {
    const symbol = String(pair || "").trim().toUpperCase();
    const next = (state.getWatchedPairs ? state.getWatchedPairs() : []).filter((item) => item !== symbol);
    if (state.saveWatchedPairs) state.saveWatchedPairs(next);
    await sendWithMenu(bot, msg.chat.id, `🗑 Removed ${symbol}`);
  }

  async function actionScan(msg, options = {}) {
    await bot.sendMessage(msg.chat.id, "🔎 Running manual scan...", buildMainMenu());

    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      ...(options || {}),
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

    await sendWithMenu(bot, msg.chat.id, text);
  }

  async function actionDryrun(msg) {
    const summary = dryrun.pnlSummary();

    const finalPnl =
      typeof dryrun.pnlModelSummary === "function"
        ? dryrun.pnlModelSummary("pnl2")
        : summary.pnl2 || {
            totalSignals: 0,
            targetCount: 0,
            slCount: 0,
            winRate: 0,
            lossRate: 0,
            cumulativeProfitLoss: 0,
          };

    await sendWithMenu(
      bot,
      msg.chat.id,
      [
        "🧪 Dry-run Summary",
        `Open/Monitoring Trades: ${summary.openCount || 0}`,
        `Fully Closed Trades: ${summary.closedCount || 0}`,
        `Blocking Signals: ${summary.blockingSignals || 0}`,
        `Background Monitoring: ${summary.backgroundMonitoring || 0}`,
        `Open Unrealized PNL: ${summary.openUnrealized || 0}`,
        `Combined Realized PNL: ${summary.realized || 0}`,
        "",
        formatFinalPnlSummary(finalPnl),
      ].join("\n")
    );
  }

  async function actionPnl(msg) {
    const finalPnl =
      typeof dryrun.pnlModelSummary === "function"
        ? dryrun.pnlModelSummary("pnl2")
        : dryrun.pnlSummary().pnl2 || {
            totalSignals: 0,
            targetCount: 0,
            slCount: 0,
            winRate: 0,
            lossRate: 0,
            cumulativeProfitLoss: 0,
          };

    await sendWithMenu(bot, msg.chat.id, formatFinalPnlSummary(finalPnl));
  }

  async function actionSignals(msg) {
    const open = typeof dryrun.loadOpenPositions === "function" ? dryrun.loadOpenPositions() : [];
    const activeSlots = getActiveSignalSlots();

    if (!open.length) {
      await sendWithMenu(
        bot,
        msg.chat.id,
        `No active monitored trades.\nConfigured signal slots: ${activeSlots}`
      );
      return;
    }

    const text = open
      .slice(0, 20)
      .map(
        (p) =>
          `${p.pair} ${p.side} | ${p.baseTimeframe} | gate=${p.blocksNewSignals ? "BLOCKED" : "FREE"} | pnl=${p.pnl2Status || p.pnlStatus || "OPEN"} | mark=${p.currentMark}`
      )
      .join("\n");

    await sendWithMenu(
      bot,
      msg.chat.id,
      `📡 Monitored Trades\nSignal slots used: ${open.filter((p) => p.blocksNewSignals).length}/${activeSlots}\n${text}`
    );
  }

  async function actionClosed(msg) {
    const closed = typeof dryrun.loadClosedTrades === "function"
      ? dryrun.loadClosedTrades().slice(-20).reverse()
      : [];

    if (!closed.length) {
      await sendWithMenu(bot, msg.chat.id, "No fully closed trades.");
      return;
    }

    const text = closed
      .map(
        (p) =>
          `${p.pair} ${p.side} | pnl=${p.pnl2Status || p.pnlStatus || "CLOSED"} | realized=${p.realizedPnl || p.pnl2PnlAmount || 0}`
      )
      .join("\n");

    await sendWithMenu(bot, msg.chat.id, `📦 Fully Closed Trades\n${text}`);
  }

  async function actionDryrunLong(msg) {
    await bot.sendMessage(msg.chat.id, "🧪 Building LONG dry-run tests...", buildMainMenu());

    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const longCandidates = (summary.topCandidates || []).filter((c) => c.side === "LONG");
    const added = longCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await sendWithMenu(bot, msg.chat.id, summarizeDryrunInsert(added, "LONG"));
  }

  async function actionDryrunShort(msg) {
    await bot.sendMessage(msg.chat.id, "🧪 Building SHORT dry-run tests...", buildMainMenu());

    const summary = await callbacks.runScan({
      manual: true,
      chatId: msg.chat.id,
      suppressSignals: true,
    });

    const shortCandidates = (summary.topCandidates || []).filter((c) => c.side === "SHORT");
    const added = shortCandidates.map((candidate) => dryrun.registerSignal(candidate)).filter(Boolean);

    await sendWithMenu(bot, msg.chat.id, summarizeDryrunInsert(added, "SHORT"));
  }

  async function actionStrategies(msg) {
    const index = getStrategiesIndex();
    await sendWithMenu(bot, msg.chat.id, `🧠 Saved learned strategies: ${index.length}`);
  }

  async function actionStrategyList(msg) {
    const index = getStrategiesIndex().slice(0, 100);

    if (!index.length) {
      await sendWithMenu(bot, msg.chat.id, "No saved strategies yet.");
      return;
    }

    const text = index
      .map(
        (s) =>
          `${s.pair} | ${s.direction} | ${s.eventTime} | mainTF=${s.mainSourceTimeframe || "n/a"} | savedTFs=${(s.savedTimeframes || []).join(",")} | supportTFs=${(s.supportingTimeframes || []).join(",")}`
      )
      .join("\n");

    await sendWithMenu(bot, msg.chat.id, `🗂 Strategy List\n${text}`);
  }

  async function actionStrategy(msg, pair) {
    const symbol = String(pair || "").trim().toUpperCase();

    if (!symbol) {
      await sendWithMenu(bot, msg.chat.id, "Use: /strategy BTCUSDT");
      return;
    }

    const strategiesForPair = getStrategyByPair(symbol);

    if (!strategiesForPair.length) {
      await sendWithMenu(bot, msg.chat.id, `No strategy saved for ${symbol}`);
      return;
    }

    for (const strategy of strategiesForPair.slice(0, 20)) {
      const chunks = formatStrategyMessage(strategy);
      for (const chunk of chunks) {
        await bot.sendMessage(msg.chat.id, chunk, buildMainMenu());
      }
    }
  }

  async function actionRebuildStrategies(msg) {
    const rebuilt = rebuildStrategiesIndexFromFiles();
    await sendWithMenu(
      bot,
      msg.chat.id,
      `♻️ Strategy index rebuilt.\nTotal strategies indexed: ${rebuilt.length}`
    );
  }

  async function actionClearStrategies(msg) {
    const result = clearAllTradingStrategies();
    await sendWithMenu(
      bot,
      msg.chat.id,
      `🗑 All trading strategies cleared.\nRemoved files: ${result.removedFiles}\nIndex cleared: ${result.indexCleared ? "Yes" : "No"}`
    );
  }

  async function actionClearStatus(msg) {
    const result = clearAllTradingStatus();
    await sendWithMenu(
      bot,
      msg.chat.id,
      `🧹 All trading status and PNL data cleared.\nFiles reset: ${result.files}\nDone: ${result.cleared ? "Yes" : "No"}`
    );
  }

  async function actionRetentionInfo(msg) {
    const hours = getStrategyRetentionHours();
    await sendWithMenu(
      bot,
      msg.chat.id,
      `⏱ Current strategy retention is ${hours}h\n\nTo change it:\n/strategyretentionhour 4h`
    );
  }

  async function actionActiveSignalSlotsInfo(msg) {
    const slots = getActiveSignalSlots();
    const summary = typeof dryrun.pnlSummary === "function"
      ? dryrun.pnlSummary()
      : { blockingSignals: 0 };

    await sendWithMenu(
      bot,
      msg.chat.id,
      `🎛 Current active signal slots: ${slots}\nUsed slots: ${summary.blockingSignals || 0}/${slots}\n\nTo change it:\n/activesignalslot 2`
    );
  }

  async function actionSetRetention(msg, value) {
    const hours = parseRetentionHours(value);

    if (!hours) {
      await sendWithMenu(
        bot,
        msg.chat.id,
        "Invalid format.\nUse like:\n/strategyretentionhour 4h"
      );
      return;
    }

    setStrategyRetentionHours(hours);
    const pruneResult = pruneStrategiesByRetentionHours(hours);

    await sendWithMenu(
      bot,
      msg.chat.id,
      [
        `✅ Strategy retention updated to ${hours}h`,
        `Expired strategy files removed: ${pruneResult.removedFiles}`,
        `Remaining indexed strategies: ${pruneResult.remainingStrategies}`,
      ].join("\n")
    );
  }

  async function actionSetActiveSignalSlots(msg, value) {
    const slots = parsePositiveInt(value);

    if (!slots) {
      await sendWithMenu(
        bot,
        msg.chat.id,
        "Invalid format.\nUse like:\n/activesignalslot 2"
      );
      return;
    }

    setActiveSignalSlots(slots);
    const summary = typeof dryrun.pnlSummary === "function"
      ? dryrun.pnlSummary()
      : { blockingSignals: 0 };

    await sendWithMenu(
      bot,
      msg.chat.id,
      [
        `✅ Active signal slots updated to ${slots}`,
        `Current used slots: ${summary.blockingSignals || 0}/${slots}`,
      ].join("\n")
    );
  }

  bot.onText(commandRegex("start"), actionStart);
  bot.onText(commandRegex("menu"), actionStart);
  bot.onText(commandRegex("help"), actionHelp);
  bot.onText(commandRegex("status"), actionStatus);
  bot.onText(commandRegex("pairs"), actionPairs);

  bot.onText(commandRegex("addpair", true), async (msg, match) => {
    await actionAddPair(msg, match[1]);
  });

  bot.onText(commandRegex("removepair", true), async (msg, match) => {
    await actionRemovePair(msg, match[1]);
  });

  bot.onText(commandRegex("scan"), async (msg) => {
    await actionScan(msg);
  });

  bot.onText(commandRegex("dryrun"), async (msg) => {
    await actionDryrun(msg);
  });

  bot.onText(commandRegex("pnl"), async (msg) => {
    await actionPnl(msg);
  });

  bot.onText(commandRegex("signals"), async (msg) => {
    await actionSignals(msg);
  });

  bot.onText(commandRegex("closed"), async (msg) => {
    await actionClosed(msg);
  });

  bot.onText(commandRegex("dryrunlong"), async (msg) => {
    await actionDryrunLong(msg);
  });

  bot.onText(commandRegex("dryrunshort"), async (msg) => {
    await actionDryrunShort(msg);
  });

  bot.onText(commandRegex("strategies"), async (msg) => {
    await actionStrategies(msg);
  });

  bot.onText(commandRegex("strategylist"), async (msg) => {
    await actionStrategyList(msg);
  });

  bot.onText(commandRegex("strategy", true), async (msg, match) => {
    await actionStrategy(msg, match[1]);
  });

  bot.onText(commandRegex("rebuildstrategies"), async (msg) => {
    await actionRebuildStrategies(msg);
  });

  bot.onText(commandRegex("clearalltradingstrategy"), async (msg) => {
    await actionClearStrategies(msg);
  });

  bot.onText(commandRegex("clearalltradingstatus"), async (msg) => {
    await actionClearStatus(msg);
  });

  bot.onText(commandRegex("activesignalslot", true), async (msg, match) => {
    await actionSetActiveSignalSlots(msg, match[1]);
  });

  bot.onText(commandRegex("strategyretentionhour", true), async (msg, match) => {
    await actionSetRetention(msg, match[1]);
  });

  bot.on("message", async (msg) => {
    const text = String(msg.text || "").trim();
    if (!text) return;
    if (text.startsWith("/")) return;

    try {
      if (isButtonText(text, BUTTONS.STATUS)) return actionStatus(msg);
      if (isButtonText(text, BUTTONS.PAIRS)) return actionPairs(msg);
      if (isButtonText(text, BUTTONS.SCAN)) return actionScan(msg);
      if (isButtonText(text, BUTTONS.PNL)) return actionPnl(msg);
      if (isButtonText(text, BUTTONS.SIGNALS)) return actionSignals(msg);
      if (isButtonText(text, BUTTONS.CLOSED)) return actionClosed(msg);
      if (isButtonText(text, BUTTONS.DRYRUN)) return actionDryrun(msg);
      if (isButtonText(text, BUTTONS.DRYRUN_LONG)) return actionDryrunLong(msg);
      if (isButtonText(text, BUTTONS.DRYRUN_SHORT)) return actionDryrunShort(msg);
      if (isButtonText(text, BUTTONS.STRATEGIES)) return actionStrategies(msg);
      if (isButtonText(text, BUTTONS.STRATEGY_LIST)) return actionStrategyList(msg);
      if (isButtonText(text, BUTTONS.REBUILD_STRATEGIES)) return actionRebuildStrategies(msg);
      if (isButtonText(text, BUTTONS.CLEAR_STATUS)) return actionClearStatus(msg);
      if (isButtonText(text, BUTTONS.CLEAR_STRATEGIES)) return actionClearStrategies(msg);
      if (isButtonText(text, BUTTONS.RETENTION)) return actionRetentionInfo(msg);
      if (isButtonText(text, BUTTONS.ACTIVE_SLOTS)) return actionActiveSignalSlotsInfo(msg);
      if (isButtonText(text, BUTTONS.HELP)) return actionHelp(msg);
      if (isButtonText(text, BUTTONS.MENU)) return actionStart(msg);
    } catch (error) {
      console.error("Telegram button handler error:", error.message);
      await sendWithMenu(bot, msg.chat.id, `Error: ${error.message}`);
    }
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
  buildMainMenu,
  loadRuntimeSettings,
  saveRuntimeSettings,
  getStrategyRetentionHours,
  setStrategyRetentionHours,
  getActiveSignalSlots,
  setActiveSignalSlots,
  pruneStrategiesByRetentionHours,
  clearAllTradingStrategies,
  clearAllTradingStatus,
};
