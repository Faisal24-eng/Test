// ================================================
// NEXUS TRADING TERMINAL - WEB APP CONTROLLER
// ================================================
import { eventBus } from './lib/event-bus.js';

/**
 * Popup UI Controller
 * Handles state synchronization, event binding, and UI updates
 */
class PopupController {
    constructor() {
        this.state = null;
        this.config = null;
        this.indicatorConfig = null;
        this.orderConfig = null;
        this.latestData = null;

        this.timeUpdateInterval = null;

        this.init();
    }

    /**
     * Initialize popup
     */
    async init() {
        console.log('[Nexus Popup] Initializing...');

        // Wait for service worker to be ready
        const ready = await this.waitForServiceWorker();
        if (!ready) {
            console.error('[Nexus Popup] Service worker failed to respond. Please reload extension.');
            this.showNotification('Service worker unavailable. Please reload.', 'error');
            return;
        }

        // Get initial state from background
        await this.loadState();

        // Bind event listeners
        this.bindEvents();

        // Start time updates
        this.startTimeUpdates();

        // Listen for updates from background
        this.setupMessageListener();

        // Initialize new features
        await this.initTradeHistory();
        await this.initSettingsTab();

        // Update UI
        this.updateUI();

        console.log('[Nexus Popup] Ready');
    }

    /**
     * Wait for service worker to be ready
     */
    async waitForServiceWorker(retries = 10, delay = 500) {
        // In Web App, background-engine runs in the same context
        return true;
    }

    /**
     * Helper to send messages safely
     */
    async sendMessage(message, timeoutMs) {
        try {
            return await eventBus.sendMessage(message, timeoutMs);
        } catch (error) {
            console.error('[Nexus App] Exception sending message:', error);
            return null;
        }
    }

    /**
     * Load state from background
     */
    async loadState() {
        try {
            const response = await this.sendMessage({ action: 'getFullState' });

            if (response && response.success) {
                this.state = response.state;
                this.config = response.config;
                this.indicatorConfig = response.indicatorConfig;
                this.orderConfig = response.orderConfig;
                this.latestData = response.latestData;
            } else {
                console.warn('[Nexus Popup] Failed to load state or empty response');
            }
        } catch (error) {
            console.error('[Nexus Popup] Error loading state:', error);
        }
    }

    /**
     * Bind all event listeners
     */
    bindEvents() {
        // Control buttons
        document.getElementById('btnStart').addEventListener('click', () => this.handleStart());
        document.getElementById('btnStop').addEventListener('click', () => this.handleStop());

        // Tabs
        document.querySelectorAll('.tab').forEach(tab => {
            tab.addEventListener('click', (e) => this.handleTabClick(e));
        });

        // Accordion headers
        document.querySelectorAll('.indicator-header').forEach(header => {
            header.addEventListener('click', (e) => this.handleAccordionClick(e));
        });

        // Save All button
        document.getElementById('btnSaveAll').addEventListener('click', () => this.saveAllSettings());

        // MEXC
        document.getElementById('btnTestMexc').addEventListener('click', () => this.testMEXC());
        document.getElementById('btnManualLong').addEventListener('click', () => this.manualLong());
        document.getElementById('btnManualShort').addEventListener('click', () => this.manualShort());
        document.getElementById('btnManualClose').addEventListener('click', () => this.manualClose());

        // Backtest
        document.getElementById('btnRunBacktest').addEventListener('click', () => this.runBacktest());
        document.getElementById('btnStopBacktest').addEventListener('click', () => this.stopBacktest());
        document.getElementById('btnExportCSV').addEventListener('click', () => this.exportCSV());

        // Settings
        document.getElementById('btnSyncTime').addEventListener('click', () => this.syncTime());
        document.getElementById('btnResetConfig').addEventListener('click', () => this.resetConfig());

        // Set default backtest dates
        this.setDefaultBacktestDates();
    }

    /**
     * Setup message listener for background updates
     */
    setupMessageListener() {
        eventBus.onBroadcast((message) => {
            switch (message.type) {
                case 'dataUpdate':
                    // Update latestData from the event
                    if (message.event && message.event.data) {
                        // Update specific market data based on event type
                        if (!this.latestData) {
                            this.latestData = { market1: {}, market2: {} };
                        }
                        const marketKey = message.event.market === 1 ? 'market1' : 'market2';
                        if (message.event.type === 'ohlcv') {
                            // Get the latest candle from the array
                            const data = message.event.data;
                            this.latestData[marketKey].ohlcv = Array.isArray(data) ? data[data.length - 1] : data;
                        } else if (message.event.type === 'orderbook') {
                            this.latestData[marketKey].orderbook = message.event.data;
                        }
                    }
                    // Update state from background message
                    if (message.state) {
                        this.state = message.state;
                    }
                    this.updateLatestDataUI();
                    this.updateStatusUI();
                    break;

                case 'signals':
                    this.updateSignalsUI(message.signals);
                    break;

                case 'backtestProgress':
                    this.updateBacktestProgress(message.progress);
                    break;
            }
        });
    }

    /**
     * Update signals UI (called when new signals received from background)
     */
    updateSignalsUI(signals) {
        // Log signals for debugging (UI display can be enhanced later)
        if (signals) {
            console.log('[Nexus Popup] Signals:', signals);
        }
    }

    /**
     * Start time update interval
     */
    startTimeUpdates() {
        this.updateTimeDisplay();
        this.timeUpdateInterval = setInterval(() => this.updateTimeDisplay(), 1000);
    }

    /**
     * Update time display
     */
    updateTimeDisplay() {
        const offset = this.state?.systemTimeOffset || 0;
        const now = new Date(Date.now() + offset);
        const timeStr = now.toLocaleTimeString('en-US', { hour12: false });
        document.getElementById('systemTime').textContent = timeStr;
    }

    /**
     * Update main UI
     */
    updateUI() {
        this.updateStatusUI();
        this.updateConfigUI();
        this.updateIndicatorUI();
        this.updateOrderUI();
        this.updateLatestDataUI();
    }

    /**
     * Update status indicators
     */
    updateStatusUI() {
        const statusIndicator = document.getElementById('statusIndicator');
        const statusText = statusIndicator.querySelector('.status-text');
        const btnStart = document.getElementById('btnStart');
        const btnStop = document.getElementById('btnStop');

        if (this.state?.isRunning) {
            statusIndicator.classList.add('running');
            statusText.textContent = this.state.status || 'Running';
            btnStart.disabled = true;
            btnStop.disabled = false;
        } else {
            statusIndicator.classList.remove('running');
            statusText.textContent = 'Idle';
            btnStart.disabled = false;
            btnStop.disabled = true;
        }

        // Last update
        if (this.state?.lastUpdate) {
            const lastUpdate = new Date(this.state.lastUpdate);
            document.getElementById('lastUpdate').textContent = lastUpdate.toLocaleTimeString('en-US', { hour12: false });
        }

        // Current position
        const positionEl = document.getElementById('currentPosition');
        if (this.state?.currentPosition) {
            positionEl.textContent = (this.state.currentPosition.type || 'unknown').toUpperCase();
            positionEl.className = `info-value position-${this.state.currentPosition.type}`;
        } else {
            positionEl.textContent = 'None';
            positionEl.className = 'info-value position-none';
        }
    }

    /**
     * Update config UI
     */
    updateConfigUI() {
        if (!this.config) return;

        // Market 1 OHLCV
        const m1o = this.config.market1?.ohlcv || {};
        this.setInputValue('m1OhlcvSymbol', m1o.symbol);
        this.setSelectValue('m1OhlcvMarketType', m1o.marketType);
        this.setSelectValue('m1OhlcvInterval', m1o.interval);
        this.setInputValue('m1OhlcvQuantity', m1o.quantity);
        this.setInputValue('m1OhlcvFetchInterval', m1o.fetchInterval);

        // Market 1 Order Book
        const m1ob = this.config.market1?.orderbook || {};
        this.setInputValue('m1ObSymbol', m1ob.symbol);
        this.setSelectValue('m1ObMarketType', m1ob.marketType);
        this.setInputValue('m1ObDepth', m1ob.depth);
        this.setInputValue('m1ObFetchInterval', m1ob.fetchInterval);
        this.setSelectValue('m1ObAggregation', m1ob.aggregation);

        // Market 2 OHLCV
        const m2o = this.config.market2?.ohlcv || {};
        this.setInputValue('m2OhlcvSymbol', m2o.symbol);
        this.setSelectValue('m2OhlcvMarketType', m2o.marketType);
        this.setSelectValue('m2OhlcvInterval', m2o.interval);
        this.setInputValue('m2OhlcvQuantity', m2o.quantity);
        this.setInputValue('m2OhlcvFetchInterval', m2o.fetchInterval);

        // Market 2 Order Book
        const m2ob = this.config.market2?.orderbook || {};
        this.setInputValue('m2ObSymbol', m2ob.symbol);
        this.setSelectValue('m2ObMarketType', m2ob.marketType);
        this.setInputValue('m2ObDepth', m2ob.depth);
        this.setInputValue('m2ObFetchInterval', m2ob.fetchInterval);
        this.setSelectValue('m2ObAggregation', m2ob.aggregation);

        // Update backtest config display
        this.updateBacktestConfigUI();
    }

    /**
     * Update backtest config UI to show Data Center settings
     */
    updateBacktestConfigUI() {
        if (!this.config) return;

        // Market 1 info
        const m1 = this.config.market1?.ohlcv || {};
        const m1Text = `${m1.symbol || 'BTCUSDT'} • ${m1.interval || '1m'} • ${m1.marketType || 'perpetual'}`;
        document.getElementById('backtestMarket1Info').textContent = m1Text;

        // Market 2 info
        const m2 = this.config.market2?.ohlcv || {};
        const m2Text = `${m2.symbol || 'SOLUSDT'} • ${m2.interval || '1m'} • ${m2.marketType || 'perpetual'}`;
        document.getElementById('backtestMarket2Info').textContent = m2Text;
    }

    /**
     * Update indicator UI
     */
    updateIndicatorUI() {
        if (!this.indicatorConfig) return;

        // Update each indicator
        this.updateIndicatorSection('slowSupertrend', this.indicatorConfig.slowSupertrend);
        this.updateIndicatorSection('fastSupertrend', this.indicatorConfig.fastSupertrend);
        this.updateIndicatorSection('crossSupertrend', this.indicatorConfig.crossMarketSupertrend);
        this.updateIndicatorSection('ema200', this.indicatorConfig.ema200);
        this.updateIndicatorSection('rsi', this.indicatorConfig.rsi);
        this.updateIndicatorSection('orderBook', this.indicatorConfig.orderBook);
        this.updateIndicatorSection('adx', this.indicatorConfig.adx);
        this.updateIndicatorSection('vwap', this.indicatorConfig.vwap);
        this.updateIndicatorSection('volume', this.indicatorConfig.volume);
    }

    /**
     * Update individual indicator section
     */
    updateIndicatorSection(name, config) {
        if (!config) return;

        // Mode radios
        const modeRadio = document.querySelector(`input[name="${name}Mode"][value="${config.enabled}"]`);
        if (modeRadio) modeRadio.checked = true;

        // Protection checkbox
        const protectionCb = document.getElementById(`${name}Protection`);
        if (protectionCb) protectionCb.checked = config.positionProtection;

        // Status badge
        const statusBadge = document.getElementById(`${name}Status`);
        if (statusBadge && config.enabled) {
            statusBadge.textContent = config.enabled.toUpperCase();
            statusBadge.className = `indicator-status ${config.enabled}`;
        }

        // Specific fields based on indicator type
        this.setSelectValue(`${name}Market`, config.market);
        this.setInputValue(`${name}Timeframe`, config.timeframe);
        this.setInputValue(`${name}TfAdjust`, config.timeframeAdjustment);

        // Supertrend specific
        this.setInputValue(`${name}AtrPeriod`, config.atrPeriod);
        this.setInputValue(`${name}Multiplier`, config.multiplier);
        this.setSelectValue(`${name}Source`, config.source);
        this.setInputValue(`${name}Alignment`, config.alignmentCompensation);

        // EMA specific
        this.setInputValue(`${name}Length`, config.length);

        // RSI specific
        this.setInputValue(`${name}Overbought`, config.overbought);
        this.setInputValue(`${name}Oversold`, config.oversold);

        // Order Book specific
        this.setInputValue(`${name}Depth`, config.depth);
        this.setInputValue(`${name}Imbalance`, config.imbalanceThreshold);

        // ADX specific
        this.setInputValue(`${name}Setpoint`, config.secondarySetpoint);
        this.setInputValue(`${name}Threshold`, config.protectionThreshold);

        // VWAP specific
        this.setSelectValue(`${name}Anchor`, config.anchor);

        // Volume specific
        this.setInputValue(`${name}MaLength`, config.maLength);
        this.setInputValue(`${name}ConfirmMult`, config.confirmationMultiplier);
        this.setInputValue(`${name}AgainstMult`, config.againstMultiplier);
    }

    /**
     * Get indicator config from DOM elements
     * @param {string} name - Indicator name prefix
     * @returns {object} - Indicator configuration
     */
    getIndicatorConfig(name) {
        const config = {};

        // Common fields - read from radio button group ${name}Mode
        const modeRadio = document.querySelector(`input[name="${name}Mode"]:checked`);
        if (modeRadio) config.enabled = modeRadio.value;

        const protectionEl = document.getElementById(`${name}Protection`);
        if (protectionEl) config.positionProtection = protectionEl.checked;

        // Market and timeframe
        const marketEl = document.getElementById(`${name}Market`);
        if (marketEl) config.market = parseInt(marketEl.value);

        const timeframeEl = document.getElementById(`${name}Timeframe`);
        if (timeframeEl) config.timeframe = parseInt(timeframeEl.value);

        const tfAdjustEl = document.getElementById(`${name}TfAdjust`);
        if (tfAdjustEl) config.timeframeAdjustment = parseInt(tfAdjustEl.value);

        // Supertrend specific
        const atrPeriodEl = document.getElementById(`${name}AtrPeriod`);
        if (atrPeriodEl) config.atrPeriod = parseInt(atrPeriodEl.value);

        const multiplierEl = document.getElementById(`${name}Multiplier`);
        if (multiplierEl) config.multiplier = parseFloat(multiplierEl.value);

        const sourceEl = document.getElementById(`${name}Source`);
        if (sourceEl) config.source = sourceEl.value;

        const alignmentEl = document.getElementById(`${name}Alignment`);
        if (alignmentEl) config.alignmentCompensation = parseInt(alignmentEl.value);

        // EMA specific
        const lengthEl = document.getElementById(`${name}Length`);
        if (lengthEl) config.length = parseInt(lengthEl.value);

        // RSI specific
        const overboughtEl = document.getElementById(`${name}Overbought`);
        if (overboughtEl) config.overbought = parseInt(overboughtEl.value);

        const oversoldEl = document.getElementById(`${name}Oversold`);
        if (oversoldEl) config.oversold = parseInt(oversoldEl.value);

        // Order Book specific
        const depthEl = document.getElementById(`${name}Depth`);
        if (depthEl) config.depth = parseInt(depthEl.value);

        const imbalanceEl = document.getElementById(`${name}Imbalance`);
        if (imbalanceEl) config.imbalanceThreshold = parseFloat(imbalanceEl.value);

        // ADX specific
        const setpointEl = document.getElementById(`${name}Setpoint`);
        if (setpointEl) config.secondarySetpoint = parseInt(setpointEl.value);

        const thresholdEl = document.getElementById(`${name}Threshold`);
        if (thresholdEl) config.protectionThreshold = parseInt(thresholdEl.value);

        // VWAP specific
        const anchorEl = document.getElementById(`${name}Anchor`);
        if (anchorEl) config.anchor = anchorEl.value;

        // Volume specific
        const maLengthEl = document.getElementById(`${name}MaLength`);
        if (maLengthEl) config.maLength = parseInt(maLengthEl.value);

        const confirmMultEl = document.getElementById(`${name}ConfirmMult`);
        if (confirmMultEl) config.confirmationMultiplier = parseFloat(confirmMultEl.value);

        const againstMultEl = document.getElementById(`${name}AgainstMult`);
        if (againstMultEl) config.againstMultiplier = parseFloat(againstMultEl.value);

        return config;
    }

    /**
     * Update order config UI
     */
    updateOrderUI() {
        if (!this.orderConfig) return;

        this.setInputValue('orderAmount', this.orderConfig.amount);
        this.setInputValue('trailAmount', this.orderConfig.trailAmount);

        // MEXC status
        const mexcStatus = document.getElementById('mexcStatus');
        if (this.state?.mexcConnected) {
            mexcStatus.textContent = 'Connected';
            mexcStatus.classList.add('active');
        } else {
            mexcStatus.textContent = 'Not Connected';
            mexcStatus.classList.remove('active');
        }
    }

    /**
     * Update latest data displays
     */
    updateLatestDataUI() {
        if (!this.latestData) return;

        // Market 1 OHLCV
        if (this.latestData.market1?.ohlcv) {
            const c = this.latestData.market1.ohlcv;
            document.getElementById('m1OhlcvLatest').textContent =
                `O: ${c.open?.toFixed(2)} H: ${c.high?.toFixed(2)} L: ${c.low?.toFixed(2)} C: ${c.close?.toFixed(2)}`;
        }

        // Market 1 Order Book
        if (this.latestData.market1?.orderbook) {
            const ob = this.latestData.market1.orderbook;
            const stats = this.calculateOrderBookPercent(ob);
            document.getElementById('m1ObLatest').textContent =
                `Bid: ${stats.bidPercent.toFixed(1)}% | Ask: ${stats.askPercent.toFixed(1)}%`;
        }

        // Market 2 OHLCV
        if (this.latestData.market2?.ohlcv) {
            const c = this.latestData.market2.ohlcv;
            document.getElementById('m2OhlcvLatest').textContent =
                `O: ${c.open?.toFixed(2)} H: ${c.high?.toFixed(2)} L: ${c.low?.toFixed(2)} C: ${c.close?.toFixed(2)}`;
        }

        // Market 2 Order Book
        if (this.latestData.market2?.orderbook) {
            const ob = this.latestData.market2.orderbook;
            const stats = this.calculateOrderBookPercent(ob);
            document.getElementById('m2ObLatest').textContent =
                `Bid: ${stats.bidPercent.toFixed(1)}% | Ask: ${stats.askPercent.toFixed(1)}%`;
        }
    }

    /**
     * Calculate bid/ask percentages from raw order book data
     */
    calculateOrderBookPercent(orderbook) {
        if (!orderbook?.bids || !orderbook?.asks) {
            return { bidPercent: 0, askPercent: 0 };
        }

        const bidTotal = orderbook.bids.slice(0, 20).reduce((sum, b) => sum + (b.price * b.quantity), 0);
        const askTotal = orderbook.asks.slice(0, 20).reduce((sum, a) => sum + (a.price * a.quantity), 0);
        const total = bidTotal + askTotal;

        if (total === 0) return { bidPercent: 50, askPercent: 50 };

        return {
            bidPercent: (bidTotal / total) * 100,
            askPercent: (askTotal / total) * 100
        };
    }

    /**
     * Handle start button
     */
    async handleStart() {
        try {
            const response = await this.sendMessage({ action: 'start' });
            if (response?.success && response.state) {
                this.state = response.state;
            } else if (response?.success) {
                this.state.isRunning = true;
            }
            this.updateStatusUI();
        } catch (error) {
            console.error('Start error:', error);
        }
    }

    /**
     * Handle stop button
     */
    async handleStop() {
        try {
            const response = await this.sendMessage({ action: 'stop' });
            if (response?.success && response.state) {
                this.state = response.state;
            } else if (response?.success) {
                this.state.isRunning = false;
            }
            this.updateStatusUI();
        } catch (error) {
            console.error('Stop error:', error);
        }
    }

    /**
     * Handle tab click
     */
    handleTabClick(e) {
        const tabName = e.target.dataset.tab;

        // Update tab buttons
        document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
        e.target.classList.add('active');

        // Update tab panes
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        document.getElementById(`tab${tabName.charAt(0).toUpperCase() + tabName.slice(1)}`).classList.add('active');
    }

    /**
     * Handle accordion click
     */
    handleAccordionClick(e) {
        const header = e.currentTarget;
        const content = header.nextElementSibling;

        header.classList.toggle('open');
        content.classList.toggle('open');
    }

    /**
     * Save data center config
     */
    async saveDataConfig() {
        const config = {
            market1: {
                ohlcv: {
                    symbol: document.getElementById('m1OhlcvSymbol').value,
                    marketType: document.getElementById('m1OhlcvMarketType').value,
                    interval: document.getElementById('m1OhlcvInterval').value,
                    quantity: parseInt(document.getElementById('m1OhlcvQuantity').value),
                    fetchInterval: parseInt(document.getElementById('m1OhlcvFetchInterval').value)
                },
                orderbook: {
                    symbol: document.getElementById('m1ObSymbol').value,
                    marketType: document.getElementById('m1ObMarketType').value,
                    depth: parseInt(document.getElementById('m1ObDepth').value),
                    fetchInterval: parseInt(document.getElementById('m1ObFetchInterval').value),
                    aggregation: parseFloat(document.getElementById('m1ObAggregation').value)
                }
            },
            market2: {
                ohlcv: {
                    symbol: document.getElementById('m2OhlcvSymbol').value,
                    marketType: document.getElementById('m2OhlcvMarketType').value,
                    interval: document.getElementById('m2OhlcvInterval').value,
                    quantity: parseInt(document.getElementById('m2OhlcvQuantity').value),
                    fetchInterval: parseInt(document.getElementById('m2OhlcvFetchInterval').value)
                },
                orderbook: {
                    symbol: document.getElementById('m2ObSymbol').value,
                    marketType: document.getElementById('m2ObMarketType').value,
                    depth: parseInt(document.getElementById('m2ObDepth').value),
                    fetchInterval: parseInt(document.getElementById('m2ObFetchInterval').value),
                    aggregation: parseFloat(document.getElementById('m2ObAggregation').value)
                }
            }
        };

        await this.sendMessage({ action: 'updateConfig', config });
        this.config = config;
    }

    /**
     * Save indicator config
     */
    async saveIndicatorConfig() {
        const config = {
            slowSupertrend: this.getIndicatorConfig('slowSupertrend'),
            fastSupertrend: this.getIndicatorConfig('fastSupertrend'),
            crossMarketSupertrend: this.getIndicatorConfig('crossSupertrend'),
            ema200: this.getIndicatorConfig('ema200'),
            rsi: this.getIndicatorConfig('rsi'),
            orderBook: this.getIndicatorConfig('orderBook'),
            adx: this.getIndicatorConfig('adx'),
            vwap: this.getIndicatorConfig('vwap'),
            volume: this.getIndicatorConfig('volume')
        };

        await this.sendMessage({ action: 'updateIndicatorConfig', config });
        this.indicatorConfig = config;
    }

    /**
     * Save all settings at once
     */
    async saveAllSettings() {
        try {
            // Save data center config
            await this.saveDataConfig();

            // Save indicator config
            await this.saveIndicatorConfig();

            // Save order config
            await this.saveOrderConfig();

            this.showNotification('All settings saved!', 'success');
        } catch (error) {
            console.error('Error saving settings:', error);
            this.showNotification('Error saving settings', 'error');
        }
    }

    // ... (getIndicatorConfig skipped) ...

    /**
     * Save order config
     */
    async saveOrderConfig() {
        const config = {
            amount: parseFloat(document.getElementById('orderAmount').value),
            trailAmount: parseFloat(document.getElementById('trailAmount').value)
        };

        await this.sendMessage({ action: 'updateOrderConfig', config });
        this.orderConfig = config;
        this.showNotification('Order settings saved!');
    }

    /**
     * Test MEXC connection
     */
    async testMEXC() {
        const result = await this.sendMessage({ action: 'testMEXC' });
        const hintEl = document.getElementById('mexcHint');
        const statusEl = document.getElementById('mexcStatus');

        if (result && result.success) {
            statusEl.textContent = 'Connected';
            statusEl.classList.add('active');
            statusEl.classList.remove('error');
            hintEl.textContent = result.message;
        } else {
            statusEl.textContent = 'Not Connected';
            statusEl.classList.remove('active');
            statusEl.classList.add('error');
            hintEl.textContent = result ? result.message : 'Connection failed';
        }
    }

    /**
     * Manual order execution
     */
    async manualLong() {
        if (!this.state?.mexcConnected) {
            this.showNotification('MEXC not connected!', 'error');
            return;
        }
        await this.sendMessage({ action: 'executeLong' });
        this.showNotification('Long order sent!');
    }

    async manualShort() {
        if (!this.state?.mexcConnected) {
            this.showNotification('MEXC not connected!', 'error');
            return;
        }
        await this.sendMessage({ action: 'executeShort' });
        this.showNotification('Short order sent!');
    }

    async manualClose() {
        if (!this.state?.mexcConnected) {
            this.showNotification('MEXC not connected!', 'error');
            return;
        }
        await this.sendMessage({ action: 'closePosition' });
        this.showNotification('Close position sent!');
    }

    /**
     * Set default backtest dates
     */
    setDefaultBacktestDates() {
        const now = new Date();
        const startDate = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000); // 7 days ago

        document.getElementById('backtestStart').value = startDate.toISOString().slice(0, 16);
        document.getElementById('backtestEnd').value = now.toISOString().slice(0, 16);
    }

    /**
     * Run backtest
     */
    async runBacktest() {
        // Validate config is loaded
        if (!this.config) {
            this.showNotification('Please configure Data Center settings first', 'error');
            return;
        }

        // Validate date range
        const startDate = document.getElementById('backtestStart').value;
        const endDate = document.getElementById('backtestEnd').value;
        if (!startDate || !endDate) {
            this.showNotification('Please select start and end dates', 'error');
            return;
        }
        if (new Date(startDate) >= new Date(endDate)) {
            this.showNotification('Start date must be before end date', 'error');
            return;
        }

        // Use Data Center configuration for backtest
        const config = {
            // Market 1 settings (from Data Center)
            market1: {
                symbol: this.config?.market1?.ohlcv?.symbol || 'BTCUSDT',
                interval: this.config?.market1?.ohlcv?.interval || '1m',
                marketType: this.config?.market1?.ohlcv?.marketType || 'perpetual'
            },
            // Market 2 settings (from Data Center)
            market2: {
                symbol: this.config?.market2?.ohlcv?.symbol || 'SOLUSDT',
                interval: this.config?.market2?.ohlcv?.interval || '1m',
                marketType: this.config?.market2?.ohlcv?.marketType || 'perpetual'
            },
            // Date range
            startDate,
            endDate,
            // Trading parameters (USDT)
            orderAmountUSDT: parseFloat(document.getElementById('backtestOrderAmount').value) || 100,
            initialBalance: parseFloat(document.getElementById('backtestInitialBalance').value) || 10000,
            feePercent: parseFloat(document.getElementById('backtestFeePercent').value) ?? 0.04,
            executionMarket: parseInt(document.getElementById('backtestExecutionMarket').value) || 1
        };

        // Log config for debugging
        console.log('[Nexus Backtest] Using config:', {
            market1: `${config.market1.symbol} @ ${config.market1.interval}`,
            market2: `${config.market2.symbol} @ ${config.market2.interval}`,
            dateRange: `${startDate} to ${endDate}`
        });

        document.getElementById('backtestProgress').style.display = 'block';
        document.getElementById('backtestResults').style.display = 'none';
        document.getElementById('btnRunBacktest').disabled = true;
        document.getElementById('btnStopBacktest').disabled = false;

        try {
            // Give backtest a long timeout (10 minutes)
            const response = await this.sendMessage({ action: 'runBacktest', config }, 600000);

            if (response && response.success) {
                this.displayBacktestResults(response.results);
            } else {
                this.showNotification('Backtest failed: ' + (response ? response.error : 'Unknown error'), 'error');
            }
        } catch (error) {
            this.showNotification('Backtest error: ' + error.message, 'error');
        }

        document.getElementById('btnRunBacktest').disabled = false;
        document.getElementById('btnStopBacktest').disabled = true;
    }

    /**
     * Update backtest progress
     */
    updateBacktestProgress(progress) {
        document.getElementById('backtestProgressFill').style.width = `${progress.progress || 0}%`;
        document.getElementById('backtestProgressText').textContent =
            `${progress.phase || 'Processing'}: ${Math.round(progress.progress || 0)}%`;
    }

    /**
     * Display backtest results
     */
    displayBacktestResults(results) {
        if (!results) return;

        document.getElementById('backtestProgress').style.display = 'none';
        document.getElementById('backtestResults').style.display = 'block';

        document.getElementById('resultTrades').textContent = results.summary.totalTrades;
        document.getElementById('resultWinRate').textContent = `${results.summary.winRate}%`;
        document.getElementById('resultPF').textContent = results.summary.profitFactor;

        const pnlEl = document.getElementById('resultPnL');
        pnlEl.textContent = `$${results.summary.totalPnL}`;
        pnlEl.className = `result-value ${parseFloat(results.summary.totalPnL) >= 0 ? 'positive' : 'negative'}`;

        document.getElementById('resultDrawdown').textContent = `${results.metrics.maxDrawdown}%`;
        document.getElementById('resultAvgWin').textContent = `$${results.metrics.avgWin}`;
        document.getElementById('resultAvgLoss').textContent = `$${results.metrics.avgLoss}`;
        document.getElementById('resultLongShort').textContent =
            `${results.breakdown.longTrades}/${results.breakdown.shortTrades}`;
    }

    /**
     * Stop backtest
     */
    async stopBacktest() {
        await this.sendMessage({ action: 'stopBacktest' });
        document.getElementById('btnRunBacktest').disabled = false;
        document.getElementById('btnStopBacktest').disabled = true;
    }

    /**
     * Export CSV
     */
    async exportCSV() {
        const response = await this.sendMessage({ action: 'getBacktestProgress' });

        if (response && response.results && response.results.trades) {
            const headers = 'type,entryTime,entryPrice,exitTime,exitPrice,pnl,exitReason\n';
            const rows = response.results.trades.map(t =>
                `${t.type},${new Date(t.entryTime).toISOString()},${t.entryPrice},${new Date(t.exitTime).toISOString()},${t.exitPrice},${t.pnl?.toFixed(2)},${t.exitReason}`
            ).join('\n');

            const csv = headers + rows;
            const blob = new Blob([csv], { type: 'text/csv' });
            const url = URL.createObjectURL(blob);

            const a = document.createElement('a');
            a.href = url;
            a.download = `backtest_results_${new Date().toISOString().slice(0, 10)}.csv`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        }
    }

    /**
     * Sync time
     */
    async syncTime() {
        await this.sendMessage({ action: 'setTimeOffset', offset: 0 });
        this.state.systemTimeOffset = 0;
        document.getElementById('timeOffset').value = 0;
        this.showNotification('Time synchronized!');
    }

    /**
     * Reset config
     */
    async resetConfig() {
        if (confirm('Reset all settings to defaults?')) {
            localStorage.clear();
            window.location.reload();
        }
    }

    // Helper methods
    setInputValue(id, value) {
        const el = document.getElementById(id);
        if (el && value !== undefined) el.value = value;
    }

    setSelectValue(id, value) {
        const el = document.getElementById(id);
        if (el && value !== undefined) el.value = value;
    }

    getInputValue(id) {
        const el = document.getElementById(id);
        return el ? el.value : null;
    }

    showNotification(message, type = 'success') {
        // Create toast container if it doesn't exist
        let container = document.getElementById('toastContainer');
        if (!container) {
            container = document.createElement('div');
            container.id = 'toastContainer';
            container.className = 'toast-container';
            document.body.appendChild(container);
        }

        // Create toast element
        const toast = document.createElement('div');
        toast.className = `toast toast-${type}`;

        // Icon based on type
        const icons = {
            success: '✓',
            error: '✕',
            warning: '⚠',
            info: 'ℹ'
        };

        toast.innerHTML = `
            <span class="toast-icon">${icons[type] || icons.info}</span>
            <span class="toast-message">${message}</span>
        `;

        // Add to container
        container.appendChild(toast);

        // Trigger animation
        setTimeout(() => toast.classList.add('show'), 10);

        // Auto remove after 3 seconds
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    // ==========================================
    // TRADE HISTORY
    // ==========================================

    /**
     * Initialize trade history functionality
     */
    async initTradeHistory() {
        try {
            document.getElementById('btnClearHistory')?.addEventListener('click', () => this.clearTradeHistory());
            await this.loadTradeHistory();
        } catch (e) {
            console.error('[Nexus Popup] Failed to init trade history:', e);
        }
    }

    /**
     * Load trade history
     */
    async loadTradeHistory() {
        try {
            const response = await this.sendMessage({ action: 'getTradeHistory' });

            if (response && response.success) {
                this.displayTradeHistory(response.trades || []);
            }
        } catch (error) {
            console.error('Error loading trade history:', error);
        }
    }

    /**
     * Display trade history in UI
     */
    displayTradeHistory(trades) {
        const tbody = document.getElementById('tradeHistoryBody');
        const countBadge = document.getElementById('tradeHistoryCount');

        if (!tbody) return;

        if (trades.length === 0) {
            tbody.innerHTML = '<tr class="no-trades"><td colspan="5">No trades yet</td></tr>';
            if (countBadge) countBadge.textContent = '0 trades';
            return;
        }

        if (countBadge) countBadge.textContent = `${trades.length} trades`;

        // Show most recent trades first (up to 20)
        const recentTrades = trades.slice(-20).reverse();

        tbody.innerHTML = recentTrades.map(trade => {
            const time = new Date(trade.exitTime || trade.entryTime).toLocaleTimeString('en-US', { hour12: false });
            const pnlClass = trade.pnl >= 0 ? 'pnl-positive' : 'pnl-negative';
            const typeClass = trade.type === 'long' ? 'trade-long' : 'trade-short';

            return `
                <tr>
                    <td>${time}</td>
                    <td class="${typeClass}">${trade.type.toUpperCase()}</td>
                    <td>$${trade.entryPrice?.toFixed(2) || '--'}</td>
                    <td>$${trade.exitPrice?.toFixed(2) || '--'}</td>
                    <td class="${pnlClass}">${trade.pnl >= 0 ? '+' : ''}$${trade.pnl?.toFixed(2) || '0.00'}</td>
                </tr>
            `;
        }).join('');
    }

    /**
     * Clear trade history
     */
    async clearTradeHistory() {
        if (!confirm('Clear all trade history?')) return;

        try {
            const response = await this.sendMessage({ action: 'clearTradeHistory' });

            if (response && response.success) {
                this.showNotification('Trade history cleared', 'info');
                await this.loadTradeHistory();
            }
        } catch (error) {
            console.error('Error clearing trade history:', error);
        }
    }

    /**
     * Initialize Settings Tab
     */
    async initSettingsTab() {
        console.log('[Nexus Popup] Initializing Settings Tab...');
        const tabSettings = document.getElementById('tabSettings');
        if (tabSettings) {
            console.log('[Nexus Popup] tabSettings innerHTML length:', tabSettings.innerHTML.length);
            console.log('[Nexus Popup] tabSettings content snippet:', tabSettings.innerHTML.substring(0, 500));
        } else {
            console.error('[Nexus Popup] tabSettings element not found!');
        }

        try {
            await this.loadXPathSettings();

            document.getElementById('saveXPathConfig').addEventListener('click', () => this.saveXPathSettings());
            document.getElementById('resetXPathDefaults').addEventListener('click', () => this.resetXPathSettings());
        } catch (e) {
            console.error('[Nexus Popup] Failed to init settings tab:', e);
        }
    }

    /**
     * Load XPath settings from storage
     */
    async loadXPathSettings() {
        try {
            // Request config from background service which has access to defaults
            const response = await this.sendMessage({ action: 'getXPathConfig' });

            if (response && response.config) {
                console.log('[Nexus Popup] Loaded XPath config:', Object.keys(response.config));
                const config = response.config;
                for (const [key, value] of Object.entries(config)) {
                    // Find all inputs for this key
                    const inputs = document.querySelectorAll(`.xpath-input[data-key="${key}"]`);
                    if (inputs.length > 0) {
                        inputs.forEach(input => {
                            input.value = value;
                        });
                    } else {
                        // Fallback to ID for backward compatibility or unique items
                        const inputById = document.getElementById(`xpath_${key}`);
                        if (inputById) {
                            inputById.value = value;
                        } else {
                            console.warn(`[Nexus Popup] Input not found for XPath key: ${key}`);
                        }
                    }
                }
            } else {
                console.warn('[Nexus Popup] No XPath config received');
            }
        } catch (e) {
            console.error('Error loading XPath settings:', e);
        }
    }

    /**
     * Save XPath settings
     */
    async saveXPathSettings() {
        const newConfig = {};
        const inputs = document.querySelectorAll('.xpath-input');

        inputs.forEach(input => {
            // Get key from data-key or ID
            let key = input.dataset.key;
            if (!key && input.id) {
                key = input.id.replace('xpath_', '');
            }

            if (key && input.value.trim()) {
                newConfig[key] = input.value.trim();
            }
        });

        try {
            const response = await this.sendMessage({
                action: 'updateXPathConfig',
                config: newConfig
            });

            if (response && response.success) {
                this.showNotification('Settings saved successfully', 'success');
            }
        } catch (error) {
            console.error('Failed to save settings:', error);
            this.showNotification('Failed to save settings', 'error');
        }
    }

    /**
     * Reset XPath settings
     */
    async resetXPathSettings() {
        if (confirm('Reset all selectors to default values?')) {
            // Handled efficiently using local custom logic or clear specific key
            localStorage.removeItem('nexus_storage');
            await this.loadXPathSettings();
            this.showNotification('Defaults restored (refresh to see)', 'success');
        }
    }
}

// ================================================
// ERROR BOUNDARIES
// ================================================

/**
 * Global error handler for uncaught exceptions
 */
window.addEventListener('error', (event) => {
    console.error('[Nexus Popup] Uncaught error:', event.error);
    try {
        if (window.popupController) {
            window.popupController.showNotification('An error occurred. Check console.', 'error');
        }
    } catch (e) {
        // Fallback if showNotification fails
        console.error('[Nexus Popup] Failed to show error notification:', e);
    }
});

/**
 * Global handler for unhandled promise rejections
 */
window.addEventListener('unhandledrejection', (event) => {
    console.error('[Nexus Popup] Unhandled promise rejection:', event.reason);
    try {
        if (window.popupController) {
            window.popupController.showNotification('Async error occurred. Check console.', 'error');
        }
    } catch (e) {
        console.error('[Nexus Popup] Failed to show rejection notification:', e);
    }
    // Prevent the default browser behavior
    event.preventDefault();
});

/**
 * Safe initialization wrapper
 */
async function safeInit() {
    try {
        window.popupController = new PopupController();
    } catch (error) {
        console.error('[Nexus Popup] Failed to initialize:', error);
        // Try to show an error in the UI
        const container = document.querySelector('.popup-container');
        if (container) {
            container.innerHTML = `
                <div style="padding: 20px; color: #ff4757; text-align: center;">
                    <h3>Initialization Error</h3>
                    <p>Failed to load the extension. Please try reloading.</p>
                    <p style="font-size: 12px; color: #8b949e;">${error.message}</p>
                </div>
            `;
        }
    }
}

// Initialize popup when DOM is ready
document.addEventListener('DOMContentLoaded', safeInit);
