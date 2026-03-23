// ================================================
// NEXUS TRADING TERMINAL - RISK MANAGER
// Stop-loss, take-profit, and position sizing
// ================================================

/**
 * Risk Manager - handles all risk management calculations
 */
class RiskManager {
    constructor() {
        this.config = {
            // Stop-Loss Settings
            stopLossType: 'atr',         // 'fixed', 'atr', 'supertrend'
            fixedStopPercent: 1.0,       // For fixed % SL
            atrMultiplier: 1.5,          // For ATR-based SL

            // Take-Profit Settings
            takeProfitType: 'rr',        // 'fixed', 'rr' (risk-reward ratio)
            fixedTakeProfitPercent: 2.0, // For fixed % TP
            riskRewardRatio: 2.0,        // For R:R based TP (e.g., 2:1)

            // Position Sizing
            positionSizeType: 'fixed',   // 'fixed', 'percent', 'risk'
            fixedPositionSize: 100,      // Fixed USD amount
            percentOfBalance: 5,         // % of balance
            riskPerTrade: 1.0,           // % of balance to risk per trade

            // Risk Controls
            maxDailyDrawdown: 5.0,       // Max daily loss % before pausing
            maxTotalDrawdown: 15.0,      // Max total drawdown % before pausing
            maxConsecutiveLosses: 5,     // Pause after N consecutive losses
            cooldownAfterLoss: 0,        // Minutes to wait after a loss

            // Trailing Stop
            enableTrailingStop: false,
            trailingStopActivation: 1.0, // Activate after X% profit
            trailingStopDistance: 0.5    // Trail by X%
        };

        // State tracking
        this.dailyPnL = 0;
        this.dailyStartBalance = null;
        this.peakBalance = null;
        this.consecutiveLosses = 0;
        this.lastLossTime = null;
        this.tradeCount = 0;
    }

    /**
     * Update configuration
     * @param {object} newConfig - New config values
     */
    updateConfig(newConfig) {
        this.config = { ...this.config, ...newConfig };
    }

    /**
     * Reset daily tracking (call at UTC 00:00)
     * @param {number} currentBalance - Current balance
     */
    resetDaily(currentBalance) {
        this.dailyPnL = 0;
        this.dailyStartBalance = currentBalance;
        if (this.peakBalance === null || currentBalance > this.peakBalance) {
            this.peakBalance = currentBalance;
        }
    }

    /**
     * Calculate stop-loss price
     * @param {number} entryPrice - Entry price
     * @param {string} direction - 'long' or 'short'
     * @param {number} atr - Current ATR value (optional, for ATR-based SL)
     * @param {number} supertrendValue - Supertrend value (optional, for ST-based SL)
     * @returns {number} - Stop-loss price
     */
    calculateStopLoss(entryPrice, direction, atr = null, supertrendValue = null) {
        const { stopLossType, fixedStopPercent, atrMultiplier } = this.config;

        let stopDistance = 0;

        switch (stopLossType) {
            case 'fixed':
                stopDistance = entryPrice * (fixedStopPercent / 100);
                break;

            case 'atr':
                if (atr) {
                    stopDistance = atr * atrMultiplier;
                } else {
                    // Fallback to fixed if ATR not available
                    stopDistance = entryPrice * (fixedStopPercent / 100);
                }
                break;

            case 'supertrend':
                if (supertrendValue) {
                    // Use Supertrend value directly as stop
                    return supertrendValue;
                } else {
                    stopDistance = entryPrice * (fixedStopPercent / 100);
                }
                break;

            default:
                stopDistance = entryPrice * (fixedStopPercent / 100);
        }

        // Apply direction
        if (direction === 'long') {
            return entryPrice - stopDistance;
        } else {
            return entryPrice + stopDistance;
        }
    }

    /**
     * Calculate take-profit price
     * @param {number} entryPrice - Entry price
     * @param {number} stopLoss - Stop-loss price
     * @param {string} direction - 'long' or 'short'
     * @returns {number} - Take-profit price
     */
    calculateTakeProfit(entryPrice, stopLoss, direction) {
        const { takeProfitType, fixedTakeProfitPercent, riskRewardRatio } = this.config;

        let tpDistance = 0;

        switch (takeProfitType) {
            case 'fixed':
                tpDistance = entryPrice * (fixedTakeProfitPercent / 100);
                break;

            case 'rr':
                // Calculate based on risk-reward ratio
                const riskDistance = Math.abs(entryPrice - stopLoss);
                tpDistance = riskDistance * riskRewardRatio;
                break;

            default:
                tpDistance = entryPrice * (fixedTakeProfitPercent / 100);
        }

        // Apply direction
        if (direction === 'long') {
            return entryPrice + tpDistance;
        } else {
            return entryPrice - tpDistance;
        }
    }

    /**
     * Calculate position size
     * @param {number} balance - Current balance
     * @param {number} entryPrice - Entry price
     * @param {number} stopLoss - Stop-loss price
     * @returns {number} - Position size in USD
     */
    calculatePositionSize(balance, entryPrice, stopLoss) {
        const { positionSizeType, fixedPositionSize, percentOfBalance, riskPerTrade } = this.config;

        switch (positionSizeType) {
            case 'fixed':
                return Math.min(fixedPositionSize, balance);

            case 'percent':
                return Math.min(balance * (percentOfBalance / 100), balance);

            case 'risk':
                // Calculate position size based on risk per trade
                // Risk = Position Size * (|Entry - SL| / Entry)
                // Position Size = (Balance * Risk%) / (|Entry - SL| / Entry)
                const riskAmount = balance * (riskPerTrade / 100);
                const stopPercent = Math.abs(entryPrice - stopLoss) / entryPrice;

                if (stopPercent > 0) {
                    const calculatedSize = riskAmount / stopPercent;
                    return Math.min(calculatedSize, balance);
                }
                return Math.min(fixedPositionSize, balance);

            default:
                return Math.min(fixedPositionSize, balance);
        }
    }

    /**
     * Calculate trailing stop price
     * @param {number} entryPrice - Original entry price
     * @param {number} currentPrice - Current market price
     * @param {number} currentStop - Current stop-loss price
     * @param {string} direction - 'long' or 'short'
     * @returns {number|null} - New stop price or null if no update needed
     */
    calculateTrailingStop(entryPrice, currentPrice, currentStop, direction) {
        if (!this.config.enableTrailingStop) return null;

        const { trailingStopActivation, trailingStopDistance } = this.config;

        // Calculate current profit %
        let profitPercent;
        if (direction === 'long') {
            profitPercent = ((currentPrice - entryPrice) / entryPrice) * 100;
        } else {
            profitPercent = ((entryPrice - currentPrice) / entryPrice) * 100;
        }

        // Check if trailing stop should be activated
        if (profitPercent < trailingStopActivation) {
            return null;
        }

        // Calculate new stop based on trailing distance
        const trailDistance = currentPrice * (trailingStopDistance / 100);
        let newStop;

        if (direction === 'long') {
            newStop = currentPrice - trailDistance;
            // Only move stop up, never down
            if (newStop > currentStop) {
                return newStop;
            }
        } else {
            newStop = currentPrice + trailDistance;
            // Only move stop down, never up
            if (newStop < currentStop) {
                return newStop;
            }
        }

        return null;
    }

    /**
     * Check if trading should be paused due to risk limits
     * @param {number} currentBalance - Current balance
     * @returns {object} - { shouldPause: boolean, reason: string }
     */
    checkRiskLimits(currentBalance) {
        const { maxDailyDrawdown, maxTotalDrawdown, maxConsecutiveLosses, cooldownAfterLoss } = this.config;

        // Check consecutive losses
        if (this.consecutiveLosses >= maxConsecutiveLosses) {
            return {
                shouldPause: true,
                reason: `Max consecutive losses reached (${this.consecutiveLosses})`
            };
        }

        // Check cooldown after loss
        if (cooldownAfterLoss > 0 && this.lastLossTime) {
            const cooldownMs = cooldownAfterLoss * 60 * 1000;
            if (Date.now() - this.lastLossTime < cooldownMs) {
                const remainingMs = cooldownMs - (Date.now() - this.lastLossTime);
                return {
                    shouldPause: true,
                    reason: `Cooldown active (${Math.ceil(remainingMs / 60000)}min remaining)`
                };
            }
        }

        // Check daily drawdown
        if (this.dailyStartBalance !== null) {
            const dailyDrawdown = ((this.dailyStartBalance - currentBalance) / this.dailyStartBalance) * 100;
            if (dailyDrawdown >= maxDailyDrawdown) {
                return {
                    shouldPause: true,
                    reason: `Daily drawdown limit reached (${dailyDrawdown.toFixed(2)}%)`
                };
            }
        }

        // Check total drawdown from peak
        if (this.peakBalance !== null) {
            const totalDrawdown = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
            if (totalDrawdown >= maxTotalDrawdown) {
                return {
                    shouldPause: true,
                    reason: `Total drawdown limit reached (${totalDrawdown.toFixed(2)}%)`
                };
            }
        }

        return { shouldPause: false, reason: null };
    }

    /**
     * Check if price hit stop-loss or take-profit during a candle
     * Used for backtesting
     * @param {object} position - Current position
     * @param {object} candle - OHLCV candle
     * @returns {object} - { hit: boolean, type: 'sl'|'tp'|null, price: number }
     */
    checkSLTPHit(position, candle) {
        if (!position || !position.stopLoss) {
            return { hit: false, type: null, price: null };
        }

        const { stopLoss, takeProfit, type: direction } = position;

        if (direction === 'long') {
            // For longs: SL is below entry, TP is above
            // Check SL first (worst case)
            if (candle.low <= stopLoss) {
                return { hit: true, type: 'sl', price: stopLoss };
            }
            // Check TP
            if (takeProfit && candle.high >= takeProfit) {
                return { hit: true, type: 'tp', price: takeProfit };
            }
        } else {
            // For shorts: SL is above entry, TP is below
            // Check SL first (worst case)
            if (candle.high >= stopLoss) {
                return { hit: true, type: 'sl', price: stopLoss };
            }
            // Check TP
            if (takeProfit && candle.low <= takeProfit) {
                return { hit: true, type: 'tp', price: takeProfit };
            }
        }

        return { hit: false, type: null, price: null };
    }

    /**
     * Record trade result for tracking
     * @param {number} pnl - Trade P&L
     * @param {number} newBalance - Balance after trade
     */
    recordTradeResult(pnl, newBalance) {
        this.tradeCount++;
        this.dailyPnL += pnl;

        if (pnl < 0) {
            this.consecutiveLosses++;
            this.lastLossTime = Date.now();
        } else {
            this.consecutiveLosses = 0;
        }

        // Update peak balance
        if (this.peakBalance === null || newBalance > this.peakBalance) {
            this.peakBalance = newBalance;
        }
    }

    /**
     * Get current risk state for UI display
     * @param {number} currentBalance - Current balance
     * @returns {object}
     */
    getRiskState(currentBalance) {
        let dailyDrawdown = 0;
        let totalDrawdown = 0;

        if (this.dailyStartBalance !== null) {
            dailyDrawdown = ((this.dailyStartBalance - currentBalance) / this.dailyStartBalance) * 100;
        }

        if (this.peakBalance !== null) {
            totalDrawdown = ((this.peakBalance - currentBalance) / this.peakBalance) * 100;
        }

        const riskCheck = this.checkRiskLimits(currentBalance);

        return {
            dailyPnL: this.dailyPnL,
            dailyDrawdown,
            totalDrawdown,
            consecutiveLosses: this.consecutiveLosses,
            tradeCount: this.tradeCount,
            isPaused: riskCheck.shouldPause,
            pauseReason: riskCheck.reason,
            config: this.config
        };
    }

    /**
     * Reset all state (for backtesting)
     */
    reset() {
        this.dailyPnL = 0;
        this.dailyStartBalance = null;
        this.peakBalance = null;
        this.consecutiveLosses = 0;
        this.lastLossTime = null;
        this.tradeCount = 0;
    }
}

// Singleton instance
const riskManager = new RiskManager();

export default riskManager;
export { RiskManager };
