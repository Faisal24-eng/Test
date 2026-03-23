// ================================================
// NEXUS TRADING TERMINAL - BACKGROUND SERVICE WORKER
// Core background logic and state management
// ================================================

// Import modules
import { eventBus } from './lib/event-bus.js';
import * as Storage from './lib/storage.js';
import dataCenter from './lib/data-center.js';
import signalEngine from './lib/signal-engine.js';
import backtester from './lib/backtester.js';
import * as CandleTiming from './lib/candle-timing.js';

/**
 * Background Service - manages all state and data fetching
 */
class BackgroundService {
    constructor() {
        this.state = {
            isRunning: false,
            status: 'idle',
            lastUpdate: null,
            systemTimeOffset: 0,
            currentPosition: null,
            mexcTabId: null
        };

        this.config = null;
        this.indicatorConfig = null;
        this.orderConfig = null;

        // Alarm names
        this.ALARM_TICK = 'nexus_tick';
        this.ALARM_PRE_CLOSE = 'nexus_pre_close';
        this.ALARM_POST_CLOSE = 'nexus_post_close';
        this.ALARM_KEEPALIVE = 'nexus_keepalive';  // Prevents service worker termination
        
        this.timers = {};

        this.init();
    }

    /**
     * Initialize background service
     */
    async init() {
        console.log('[Nexus] Background service initializing...');
        try {
            // Initialize storage with defaults
            await Storage.initializeDefaults();

            // Load saved state
            await this.loadState();

            // Set up listeners
            this.setupListeners();

            // Set up data center listener
            dataCenter.addListener((event) => this.onDataUpdate(event));

            // CRITICAL: Resume candle-close scheduling if we were running
            if (this.state.isRunning) {
                console.log('[Nexus] Resuming from running state after restart...');
                await this.ensureAlarm();
                await this.scheduleCandleCloseFetches();
            }

            console.log('[Nexus] Background service ready');
        } catch (error) {
            console.error('[Nexus] CRITICAL: Background service initialization failed:', error);
        }
    }

    /**
     * Load state from storage
     */
    async loadState() {
        try {
            const stored = await Storage.getAll();

            if (stored.systemState) {
                // Determine running state from storage, but verify alarms
                this.state = { ...this.state, ...stored.systemState };

                // If stored state says running, ensure alarm exists
                if (this.state.isRunning) {
                    await this.ensureAlarm();
                }
            }

            if (stored.systemTimeOffset) {
                this.state.systemTimeOffset = stored.systemTimeOffset;
            }

            this.config = stored.dataCenterConfig || Storage.getDefaultConfig().dataCenterConfig;
            this.indicatorConfig = stored.indicatorConfigs || Storage.getDefaultConfig().indicatorConfigs;
            this.orderConfig = stored.orderConfig || Storage.getDefaultConfig().orderConfig;

            if (stored.currentPosition) {
                this.state.currentPosition = stored.currentPosition;
            }

            // Configure data center
            dataCenter.configure(this.config);

            // Restore data center state if available
            if (stored.market1 || stored.market2) {
                dataCenter.restoreState({
                    market1: stored.market1 || {},
                    market2: stored.market2 || {}
                });
            }

        } catch (error) {
            console.error('[Nexus] Error loading state:', error);
        }
    }

    /**
     * Save state to storage
     */
    async saveState() {
        try {
            await Storage.set({
                systemState: {
                    isRunning: this.state.isRunning,
                    status: this.state.status,
                    lastUpdate: this.state.lastUpdate
                },
                systemTimeOffset: this.state.systemTimeOffset,
                currentPosition: this.state.currentPosition,
                // Persist lightweight state only (OHLCV re-fetched on restart)
                // This reduces storage from ~100KB to ~200 bytes per save
                ...dataCenter.getLightweightState()
            });
        } catch (error) {
            console.error('[Nexus] Error saving state:', error);
        }
    }

    /**
     * Set up message and alarm listeners
     */
    setupListeners() {
        eventBus.onMessage((message, sender, sendResponse) => {
            this.handleMessage(message, sender, sendResponse);
        });

        // Simulating the popup connection
        setTimeout(() => this.handlePopupConnection({ postMessage: msg => eventBus.broadcastToUI(msg) }), 500);
    }

    /**
     * Handle periodic tick (Alarm)
     */
    async handleTick() {
        if (!this.state.isRunning) {
            // Should not happen if alarm management is correct, but safety check
            return;
        }

        // Schedule smart candle-close fetches
        this.scheduleCandleCloseFetches();

        // Save state after scheduling
        this.state.lastUpdate = Date.now();
        await this.saveState();
    }

    /**
     * Schedule fetches around candle close time using chrome.alarms
     * This ensures we get the most accurate data right when candles close
     * NOTE: chrome.alarms persist across service worker restarts, unlike setTimeout
     */
    async scheduleCandleCloseFetches() {
        // Get the shortest interval from configured markets
        const interval = CandleTiming.getShortestInterval(this.config);
        const now = Date.now() + this.state.systemTimeOffset;

        // Calculate fetch schedule
        const schedule = CandleTiming.calculateFetchSchedule(interval, now);

        console.log(`[Nexus] Candle close in ${Math.round(schedule.msUntilClose / 1000)}s, scheduling fetches...`);

        // Clear any existing alarms to prevent duplicates
        await this.clearScheduledAlarms();

        // Store the interval for later use
        this.scheduledInterval = interval;

        // Schedule pre-close fetch
        if (schedule.preCloseFetchIn !== null && schedule.preCloseFetchIn > 0) {
            this.timers[this.ALARM_PRE_CLOSE] = setTimeout(() => this.executePreCloseFetch(), schedule.preCloseFetchIn);
            console.log(`[Nexus] Pre-close fetch timer set in ${Math.round(schedule.preCloseFetchIn / 1000)}s`);
        }

        // Schedule post-close fetch
        if (schedule.postCloseFetchIn > 0) {
            this.timers[this.ALARM_POST_CLOSE] = setTimeout(() => this.executePostCloseFetch(), schedule.postCloseFetchIn);
            console.log(`[Nexus] Post-close fetch timer set in ${Math.round(schedule.postCloseFetchIn / 1000)}s`);
        }
    }

    /**
     * Execute pre-close fetch (~500ms before candle closes)
     * This captures the near-final candle data
     */
    async executePreCloseFetch() {
        if (!this.state.isRunning) return;

        const interval = this.scheduledInterval || 'unknown';
        console.log(`[Nexus] Pre-close fetch executing (candle closing in ~500ms)`);

        try {
            // Fetch data
            await dataCenter.fetchOneRound();

            // Update state
            this.state.lastUpdate = Date.now();
            this.state.status = 'pre-close fetch';

            // Broadcast to popup
            this.broadcastToPopup({
                type: 'candleTiming',
                phase: 'pre-close',
                interval,
                state: this.getPublicState()
            });

        } catch (error) {
            console.error('[Nexus] Pre-close fetch error:', error);
        }
    }

    /**
     * Execute post-close fetch (~1000ms after candle closes)
     * This confirms the closed candle and captures new candle's first tick
     */
    async executePostCloseFetch() {
        if (!this.state.isRunning) return;

        const interval = this.scheduledInterval || 'unknown';
        console.log(`[Nexus] Post-close fetch executing (new candle started)`);

        try {
            // Fetch data
            await dataCenter.fetchOneRound();

            // Check signals - this is the critical moment for trading decisions
            await this.checkSignals();

            // Update state
            this.state.lastUpdate = Date.now();
            this.state.status = 'running';
            await this.saveState();

            // Broadcast to popup
            this.broadcastToPopup({
                type: 'candleTiming',
                phase: 'post-close',
                interval,
                state: this.getPublicState()
            });

            // Schedule next candle close fetches
            await this.scheduleCandleCloseFetches();

        } catch (error) {
            console.error('[Nexus] Post-close fetch error:', error);
        }
    }

    /**
     * Clear scheduled alarms (for candle-close fetches)
     */
    async clearScheduledAlarms() {
        if (this.timers[this.ALARM_PRE_CLOSE]) clearTimeout(this.timers[this.ALARM_PRE_CLOSE]);
        if (this.timers[this.ALARM_POST_CLOSE]) clearTimeout(this.timers[this.ALARM_POST_CLOSE]);
    }

    /**
     * Ensure the tick alarm is running
     */
    async ensureAlarm() {
        // Main tick timer (1 minute)
        if (!this.timers[this.ALARM_TICK]) {
            console.log('[Nexus] Creating tick timer (1 min interval)');
            this.timers[this.ALARM_TICK] = setInterval(() => this.handleTick(), 60000);
        }

        // Keep-alive timer (25 seconds)
        if (this.state.isRunning) {
            if (!this.timers[this.ALARM_KEEPALIVE]) {
                console.log('[Nexus] Creating keep-alive timer (25s interval)');
                this.timers[this.ALARM_KEEPALIVE] = setInterval(() => {
                    console.log('[Nexus] Keep-alive ping at', new Date().toISOString());
                }, 25000);
            }
        }
    }

    /**
     * Stop keep-alive when not running
     */
    async clearKeepAlive() {
        if (this.timers[this.ALARM_KEEPALIVE]) {
            clearInterval(this.timers[this.ALARM_KEEPALIVE]);
            delete this.timers[this.ALARM_KEEPALIVE];
        }
        console.log('[Nexus] Keep-alive timer cleared');
    }

    /**
     * Handle incoming messages
     */
    async handleMessage(message, sender, sendResponse) {
        try {
            switch (message.action) {
                // System control
                case 'start':
                    await this.start();
                    sendResponse({ success: true, state: this.getPublicState() });
                    break;

                case 'stop':
                    await this.stop();
                    sendResponse({ success: true, state: this.getPublicState() });
                    break;

                case 'getState':
                    sendResponse({ success: true, state: this.getPublicState() });
                    break;

                case 'getFullState':
                    sendResponse({
                        success: true,
                        state: this.getPublicState(),
                        config: this.config,
                        indicatorConfig: this.indicatorConfig,
                        orderConfig: this.orderConfig,
                        latestData: this.getLatestData()
                    });
                    break;

                // Configuration
                case 'updateConfig':
                    await this.updateConfig(message.config);
                    sendResponse({ success: true });
                    break;

                case 'updateIndicatorConfig':
                    await this.updateIndicatorConfig(message.config);
                    sendResponse({ success: true });
                    break;

                case 'updateOrderConfig':
                    await this.updateOrderConfig(message.config);
                    sendResponse({ success: true });
                    break;

                case 'updateXPathConfig':
                    await this.updateXPathConfig(message.config);
                    sendResponse({ success: true });
                    break;

                case 'getXPathConfig':
                    const xpathConfig = await this.getXPathConfig();
                    sendResponse({ config: xpathConfig });
                    break;

                // Time sync
                case 'setTimeOffset':
                    this.state.systemTimeOffset = message.offset;
                    await this.saveState();
                    sendResponse({ success: true, currentTime: this.getSystemTime() });
                    break;

                case 'getSystemTime':
                    sendResponse({ success: true, time: this.getSystemTime() });
                    break;

                // MEXC
                case 'testMEXC':
                    const result = await this.testMEXCConnection();
                    sendResponse(result);
                    break;

                case 'setMEXCTab':
                    this.state.mexcTabId = message.tabId;
                    sendResponse({ success: true });
                    break;

                // Manual order execution (from popup)
                case 'executeLong':
                    await this.executeLong();
                    sendResponse({ success: true });
                    break;

                case 'executeShort':
                    await this.executeShort();
                    sendResponse({ success: true });
                    break;

                case 'closePosition':
                    await this.executeClose();
                    sendResponse({ success: true });
                    break;

                // Backtesting
                case 'runBacktest':
                    this.runBacktest(message.config, sendResponse);
                    break;

                case 'getBacktestProgress':
                    sendResponse({
                        success: true,
                        isRunning: backtester.isRunning,
                        progress: backtester.progress,
                        results: backtester.results
                    });
                    break;

                case 'stopBacktest':
                    backtester.stop();
                    sendResponse({ success: true });
                    break;

                // Data
                case 'getLatestData':
                    sendResponse({ success: true, data: this.getLatestData() });
                    break;

                // Trade History
                case 'getTradeHistory':
                    const trades = await this.getTradeHistory();
                    sendResponse({ success: true, trades });
                    break;

                case 'clearTradeHistory':
                    await this.clearTradeHistory();
                    sendResponse({ success: true });
                    break;

                case 'ping':
                    sendResponse({ status: 'ok' });
                    break;

                default:
                    sendResponse({ success: false, error: 'Unknown action' });
            }
        } catch (error) {
            console.error('[Nexus] Message handling error:', error);
            sendResponse({ success: false, error: error.message });
        }
    }

    /**
     * Handle popup connection
     */
    handlePopupConnection(port) {
        console.log('[Nexus] Popup connected');

        // Send initial state
        port.postMessage({
            type: 'initialState',
            state: this.getPublicState(),
            config: this.config,
            indicatorConfig: this.indicatorConfig,
            orderConfig: this.orderConfig,
            latestData: this.getLatestData()
        });
    }

    /**
     * Get public state for popup
     */
    getPublicState() {
        return {
            isRunning: this.state.isRunning,
            status: this.state.status,
            lastUpdate: this.state.lastUpdate,
            systemTime: this.getSystemTime(),
            systemTimeOffset: this.state.systemTimeOffset,
            currentPosition: this.state.currentPosition,
            mexcConnected: this.state.mexcTabId !== null
        };
    }

    /**
     * Get system time with offset
     */
    getSystemTime() {
        return Date.now() + this.state.systemTimeOffset;
    }

    /**
     * Get latest data from data center
     */
    getLatestData() {
        return {
            market1: {
                ohlcv: dataCenter.getLatestCandle(1),
                orderbook: dataCenter.getOrderBook(1),
                lastOhlcvFetch: dataCenter.markets[1].lastOhlcvFetch,
                lastOrderbookFetch: dataCenter.markets[1].lastOrderbookFetch
            },
            market2: {
                ohlcv: dataCenter.getLatestCandle(2),
                orderbook: dataCenter.getOrderBook(2),
                lastOhlcvFetch: dataCenter.markets[2].lastOhlcvFetch,
                lastOrderbookFetch: dataCenter.markets[2].lastOrderbookFetch
            }
        };
    }

    /**
     * Start data fetching and signal processing
     */
    async start() {
        if (this.state.isRunning) return;

        console.log('[Nexus] Starting...');

        this.state.isRunning = true;
        this.state.status = 'starting';

        // Configure data center
        dataCenter.configure(this.config);

        // Do an initial fetch immediately
        await dataCenter.fetchOneRound();

        // Start alarm for periodic wake-ups
        await this.ensureAlarm();

        // Schedule smart candle-close fetches immediately
        await this.scheduleCandleCloseFetches();

        this.state.status = 'running';
        this.state.lastUpdate = Date.now();

        await this.saveState();

        console.log('[Nexus] Started successfully with candle-close synchronization');
    }

    /**
     * Stop data fetching
     */
    async stop() {
        if (!this.state.isRunning) return;

        console.log('[Nexus] Stopping...');

        this.state.isRunning = false;
        this.state.status = 'stopping';

        // Clear scheduled candle-close alarms
        await this.clearScheduledAlarms();

        // Clear keep-alive alarm
        await this.clearKeepAlive();

        // Stop tick alarm
        if (this.timers[this.ALARM_TICK]) {
            clearInterval(this.timers[this.ALARM_TICK]);
            delete this.timers[this.ALARM_TICK];
        }

        this.state.status = 'idle';
        this.state.lastUpdate = Date.now();

        await this.saveState();

        console.log('[Nexus] Stopped');
    }

    /**
     * Data update callback
     */
    onDataUpdate(event) {
        this.state.lastUpdate = Date.now();

        // Broadcast to popup if connected
        this.broadcastToPopup({
            type: 'dataUpdate',
            event,
            state: this.getPublicState()
        });
    }

    /**
     * Check signals and execute trades if needed
     */
    async checkSignals() {
        // Double check running state
        if (!this.state.isRunning) return;

        try {
            // Get data from data center
            const market1OHLCV = dataCenter.getOHLCV(1);
            const market2OHLCV = dataCenter.getOHLCV(2);

            // Skip if we don't have enough data yet
            if ((!market1OHLCV || market1OHLCV.length === 0) &&
                (!market2OHLCV || market2OHLCV.length === 0)) {
                return;
            }

            // Prepare data for signal engine
            const data = {
                ohlcv: {
                    market1: market1OHLCV || [],
                    market2: market2OHLCV || []
                },
                orderbook: {
                    market1: dataCenter.getOrderBook(1),
                    market2: dataCenter.getOrderBook(2)
                },
                currentPrice: dataCenter.getLatestCandle(1)?.close || 0
            };

            // Process signals
            const signals = signalEngine.processSignals(
                data,
                this.indicatorConfig,
                this.state.currentPosition
            );

            // Handle close sequence
            if (signals.closePosition && this.state.currentPosition) {
                await this.executeClose();
            }

            // Handle new trade
            if (signals.primary && signals.secondaryPass && !this.state.currentPosition) {
                if (signals.primary === 'long') {
                    await this.executeLong();
                } else if (signals.primary === 'short') {
                    await this.executeShort();
                }
            }

            // Broadcast signals to popup
            this.broadcastToPopup({
                type: 'signals',
                signals,
                state: this.getPublicState()
            });

        } catch (error) {
            console.error('[Nexus] Signal check error:', error);
        }
    }

    /**
     * Execute long order
     */
    async executeLong() {
        console.info('[Nexus] Simulated Mock Long Execution');

        try {
            this.state.currentPosition = {
                type: 'long',
                entryTime: Date.now(),
                entryPrice: dataCenter.getLatestCandle(1)?.close || 0
            };

            await this.saveState();

        } catch (error) {
            console.error('[Nexus] Long execution error:', error);
        }
    }

    /**
     * Execute short order
     */
    async executeShort() {
        console.info('[Nexus] Simulated Mock Short Execution');

        try {
            this.state.currentPosition = {
                type: 'short',
                entryTime: Date.now(),
                entryPrice: dataCenter.getLatestCandle(1)?.close || 0
            };

            await this.saveState();

        } catch (error) {
            console.error('[Nexus] Short execution error:', error);
        }
    }

    /**
     * Execute close position
     */
    async executeClose() {
        if (!this.state.currentPosition) return;

        console.info('[Nexus] Simulated Mock Close Execution');

        try {
            const exitPrice = dataCenter.getLatestCandle(1)?.close || this.state.currentPosition.entryPrice;
            const isLong = this.state.currentPosition.type === 'long';
            const priceDiff = isLong ? (exitPrice - this.state.currentPosition.entryPrice) : (this.state.currentPosition.entryPrice - exitPrice);
            const pnlPercentage = (priceDiff / this.state.currentPosition.entryPrice) * 100;
            
            const pnl = parseFloat((this.orderConfig.amount * pnlPercentage / 100).toFixed(2));
            
            await this.addTradeToHistory({
                type: this.state.currentPosition.type,
                entryTime: this.state.currentPosition.entryTime,
                exitTime: Date.now(),
                entryPrice: parseFloat(this.state.currentPosition.entryPrice.toFixed(4)),
                exitPrice: parseFloat(exitPrice.toFixed(4)),
                pnl: pnl
            });

            this.state.currentPosition = null;
            await this.saveState();

        } catch (error) {
            console.error('[Nexus] Close execution error:', error);
        }
    }

    /**
     * Update data center config
     */
    async updateConfig(config) {
        this.config = { ...this.config, ...config };
        await Storage.set({ dataCenterConfig: this.config });

        // Reconfigure data center
        dataCenter.configure(this.config);
    }

    /**
     * Update indicator config
     */
    async updateIndicatorConfig(config) {
        this.indicatorConfig = { ...this.indicatorConfig, ...config };
        await Storage.set({ indicatorConfigs: this.indicatorConfig });
    }

    /**
     * Update order config
     */
    async updateOrderConfig(config) {
        this.orderConfig = { ...this.orderConfig, ...config };
        await Storage.set({ orderConfig: this.orderConfig });
    }

    /**
     * Update XPath config
     */
    async updateXPathConfig(config) {
        // Load current config to merge
        const stored = await Storage.getAll();
        const currentXPathConfig = stored.xpathConfig || Storage.getDefaultConfig().xpathConfig;

        const newXPathConfig = { ...currentXPathConfig, ...config };
        await Storage.set({ xpathConfig: newXPathConfig });

        // Broadcast is handled by eventBus in the web app, but no content script exists yet.
    }

    /**
     * Get current XPath configuration
     */
    async getXPathConfig() {
        const stored = await Storage.getAll();
        return stored.xpathConfig || Storage.getDefaultConfig().xpathConfig;
    }

    /**
     * Test MEXC connection
     */
    async testMEXCConnection() {
        return { success: false, message: 'Execution requires backend or extension bridge in Web App mode (Pending selection)' };
    }

    /**
     * Run backtest
     */
    async runBacktest(config, sendResponse) {
        try {
            const results = await backtester.run(config, this.indicatorConfig, (progress) => {
                // Broadcast progress
                this.broadcastToPopup({
                    type: 'backtestProgress',
                    progress
                });
            });

            sendResponse({ success: true, results });

        } catch (error) {
            sendResponse({ success: false, error: error.message });
        }
    }

    /**
     * Broadcast message to popup
     */
    broadcastToPopup(message) {
        eventBus.broadcastToUI(message);
    }

    // ==========================================
    // TRADE HISTORY
    // ==========================================

    /**
     * Get trade history
     */
    async getTradeHistory() {
        try {
            const stored = JSON.parse(localStorage.getItem('nexus_tradeHistory') || '{"tradeHistory": []}');
            return stored.tradeHistory || [];
        } catch (e) {
            return [];
        }
    }

    /**
     * Add a trade to history
     */
    async addTradeToHistory(trade) {
        const trades = await this.getTradeHistory();
        trades.push(trade);

        // Keep only last 100 trades
        if (trades.length > 100) {
            trades.splice(0, trades.length - 100);
        }

        localStorage.setItem('nexus_tradeHistory', JSON.stringify({ tradeHistory: trades }));
        console.log('[Nexus] Trade logged:', trade.type, trade.pnl);
    }

    /**
     * Clear trade history
     */
    async clearTradeHistory() {
        localStorage.setItem('nexus_tradeHistory', JSON.stringify({ tradeHistory: [] }));
        console.log('[Nexus] Trade history cleared');
    }
}

// Initialize background service
const backgroundService = new BackgroundService();

// Export for debugging
self.nexusBackgroundService = backgroundService;

