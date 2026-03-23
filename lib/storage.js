// ================================================
// NEXUS TRADING TERMINAL - STORAGE ABSTRACTION
// ================================================

/**
 * Storage utility for Chrome extension
 * Provides async/await interface for chrome.storage.local
 */

const StorageKeys = {
    // System State
    SYSTEM_STATE: 'systemState',
    SYSTEM_TIME_OFFSET: 'systemTimeOffset',

    // Data Center
    DATA_CENTER_CONFIG: 'dataCenterConfig',
    OHLCV_DATA_MARKET1: 'ohlcvDataMarket1',
    OHLCV_DATA_MARKET2: 'ohlcvDataMarket2',
    ORDERBOOK_MARKET1: 'orderbookMarket1',
    ORDERBOOK_MARKET2: 'orderbookMarket2',

    // Indicator Configs
    INDICATOR_CONFIGS: 'indicatorConfigs',

    // Order Execution
    ORDER_CONFIG: 'orderConfig',
    CURRENT_POSITION: 'currentPosition',

    // Backtesting
    BACKTEST_CONFIG: 'backtestConfig',
    BACKTEST_RESULTS: 'backtestResults',

    // MEXC DOM Selectors
    XPATH_CONFIG: 'xpathConfig'
};

async function get(keys) {
    return new Promise((resolve) => {
        try {
            const allData = JSON.parse(localStorage.getItem('nexus_storage') || '{}');
            if (!keys) {
                resolve(allData);
            } else if (typeof keys === 'string') {
                resolve({ [keys]: allData[keys] });
            } else if (Array.isArray(keys)) {
                const result = {};
                keys.forEach(k => result[k] = allData[k]);
                resolve(result);
            } else {
                resolve({});
            }
        } catch (e) {
            resolve({});
        }
    });
}

/**
 * Set data in storage
 * @param {object} data - Data to store
 * @returns {Promise<void>}
 */
async function set(data) {
    return new Promise((resolve) => {
        try {
            const allData = JSON.parse(localStorage.getItem('nexus_storage') || '{}');
            const merged = { ...allData, ...data };
            localStorage.setItem('nexus_storage', JSON.stringify(merged));
            resolve();
        } catch (e) {
            resolve();
        }
    });
}

/**
 * Remove data from storage
 * @param {string|string[]} keys - Key(s) to remove
 * @returns {Promise<void>}
 */
async function remove(keys) {
    return new Promise((resolve) => {
        try {
            const allData = JSON.parse(localStorage.getItem('nexus_storage') || '{}');
            const keysToRemove = Array.isArray(keys) ? keys : [keys];
            keysToRemove.forEach(k => delete allData[k]);
            localStorage.setItem('nexus_storage', JSON.stringify(allData));
            resolve();
        } catch (e) {
            resolve();
        }
    });
}

/**
 * Clear all storage
 * @returns {Promise<void>}
 */
async function clear() {
    return new Promise((resolve) => {
        localStorage.removeItem('nexus_storage');
        resolve();
    });
}

/**
 * Get all storage data
 * @returns {Promise<object>}
 */
async function getAll() {
    return get(null);
}

/**
 * Get default configuration
 * @returns {object}
 */
function getDefaultConfig() {
    return {
        systemState: {
            isRunning: false,
            lastUpdate: null,
            status: 'idle'
        },
        systemTimeOffset: 0,
        dataCenterConfig: {
            market1: {
                ohlcv: {
                    symbol: 'BTCUSDT',
                    marketType: 'perpetual',
                    interval: '1m',
                    quantity: 500,
                    fetchInterval: 60000  // 1 minute
                },
                orderbook: {
                    symbol: 'BTCUSDT',
                    marketType: 'perpetual',
                    depth: 100,
                    fetchInterval: 10000,  // 10 seconds
                    aggregation: 10  // Aggregate prices to nearest $10
                }
            },
            market2: {
                ohlcv: {
                    symbol: 'SOLUSDT',
                    marketType: 'perpetual',
                    interval: '1m',
                    quantity: 500,
                    fetchInterval: 60000  // 1 minute
                },
                orderbook: {
                    symbol: 'SOLUSDT',
                    marketType: 'perpetual',
                    depth: 100,
                    fetchInterval: 10000,  // 10 seconds
                    aggregation: 1  // Aggregate prices to nearest $1
                }
            }
        },
        indicatorConfigs: {
            slowSupertrend: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                atrPeriod: 7,
                multiplier: 2,
                source: 'close',
                alignmentCompensation: 0
            },
            fastSupertrend: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                atrPeriod: 7,
                multiplier: 2,
                source: 'close',
                alignmentCompensation: 0
            },
            crossMarketSupertrend: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                atrPeriod: 7,
                multiplier: 2,
                source: 'close',
                alignmentCompensation: 0
            },
            ema200: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                length: 200,
                source: 'close'
            },
            rsi: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                length: 14,
                overbought: 70,
                oversold: 30
            },
            orderBook: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                depth: 50,
                imbalanceThreshold: 60
            },
            adx: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                length: 14,
                smoothing: 'wilder',
                secondarySetpoint: 20,
                protectionThreshold: 30
            },
            vwap: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                anchor: 'session',
                bands: [1, 2],
                source: 'typical'
            },
            volume: {
                enabled: 'off',
                positionProtection: false,
                market: 1,
                timeframe: 1,
                timeframeAdjustment: 100,
                maLength: 20,
                confirmationMultiplier: 1.0,
                againstMultiplier: 1.5
            }
        },
        orderConfig: {
            amount: 5,
            trailAmount: 0.3
        },
        currentPosition: {
            type: null, // 'long', 'short', or null
            entryTime: null,
            entryPrice: null
        },
        backtestConfig: {
            startDate: null,
            endDate: null,
            symbol: 'BTCUSDT',
            interval: '1m'
        },
        xpathConfig: {
            orderInput: "//input[contains(@placeholder, 'Please enter quantity')]",
            longBtn: "//div[@data-testid='contract-trade-quick-open-long-btn'] | //button[contains(., 'Open Long')]",
            shortBtn: "//div[@data-testid='contract-trade-quick-open-short-btn']",
            flashClose: "(//span[normalize-space()='Flash Close'])[1]",
            modalClose: "//span[@class='ant-modal-close-x']//*[name()='svg']",
            modalCloseSpan: "//span[@class='ant-modal-close-x']",
            openOrdersTab: "//div[@role='tab'][span[starts-with(normalize-space(), 'Open Order')]]",
            openOrders1: "//span[normalize-space()='Open Orders(1)']",
            openOrders2: "//span[normalize-space()='Open Orders(2)']",
            cancelAll: "//a[normalize-space()='Cancel All']",
            confirmBtn: "//button[@type='button' and span[normalize-space()='Confirm']]",
            confirmBtnPrimary: "//button[@class='ant-btn ant-btn-primary']//span[contains(text(),'Confirm')]",
            positionsTab: "//div[@role='tab'][span[starts-with(normalize-space(), 'Open Position')]]",
            positions1: "//span[normalize-space()='Positions(1)']",
            positions2: "//span[normalize-space()='Positions(2)']",
            tpslTrailAmountInput: "(//input[@type='text'])[5]",
            tpslAmountInput: "(//input[@type='text'])[6]",
            closeLongBtn: "//button[@data-testid='contract-trade-close-long-btn']",
            closeShortBtn: "//button[@data-testid='contract-trade-close-short-btn']",
            positionCount: "//span[contains(text(), 'Positions(')]",
            positionRow: "//div[contains(@class, 'position-row')] | //tr[contains(@class, 'position')]"
        }
    };
}

/**
 * Initialize storage with defaults if empty
 * @returns {Promise<void>}
 */
async function initializeDefaults() {
    const existing = await getAll();
    const defaults = getDefaultConfig();

    const toSet = {};
    for (const [key, value] of Object.entries(defaults)) {
        if (!(key in existing)) {
            toSet[key] = value;
        }
    }

    if (Object.keys(toSet).length > 0) {
        await set(toSet);
    }
}

// Export for module usage
if (typeof module !== 'undefined' && module.exports) {
    module.exports = { StorageKeys, get, set, remove, clear, getAll, getDefaultConfig, initializeDefaults };
}

// Export for ES modules
export { StorageKeys, get, set, remove, clear, getAll, getDefaultConfig, initializeDefaults };
