// ================================================
// NEXUS TRADING TERMINAL - SIGNAL ENGINE
// Aggregates indicator signals for trade decisions
// ================================================

import { getSupertrendSignal } from './indicators/supertrend.js';
import { getEMASignal } from './indicators/ema.js';
import { getRSISignal } from './indicators/rsi.js';
import { getADXSignal } from './indicators/adx.js';
import { getVWAPSignal } from './indicators/vwap.js';
import { getVolumeSignal } from './indicators/volume.js';
import { getOrderBookSignal } from './indicators/orderbook.js';

// NEW: Advanced filter imports
import { getMTFSignal } from './indicators/mtf-analyzer.js';
import { getSessionSignal } from './indicators/session-filter.js';
import { getCorrelationSignal } from './indicators/correlation.js';

/**
 * Signal Engine - processes all indicators and generates trading signals
 */
class SignalEngine {
    constructor() {
        this.lastSignals = {};
        this.pendingAlignments = {};
        this.lastOrderBookAnalysis = {};
        this.lastSignalTime = null;      // For cooldown tracking
        this.lastSignalType = null;      // Track last signal direction
        this.signalCooldownMs = 60000;   // Default 1 minute cooldown
        this.minConfidenceThreshold = 0; // Minimum confidence to accept signal (0-100)
        this.backtestMode = false;       // When true, skip time-based checks (cooldown, alignment)

        // NEW: Indicator weights for weighted confidence scoring (scale 1-10)
        this.indicatorWeights = {
            slowSupertrend: 10,      // Primary trend indicator
            fastSupertrend: 6,       // Fast trend indicator
            crossMarketSupertrend: 5,// Cross-market confirmation
            ema200: 7,               // Major trend filter
            rsi: 5,                  // Momentum
            adx: 6,                  // Trend strength
            vwap: 5,                 // Mean reversion
            volume: 4,               // Volume confirmation
            orderBook: 4,            // Order flow
            mtf: 8,                  // Multi-timeframe alignment
            session: 3,              // Session filter
            correlation: 5           // Cross-market correlation
        };

        // Advanced filter configs
        this.mtfConfig = {
            enabled: false,
            timeframes: ['5m', '15m', '1h'],
            minAlignmentScore: 66,
            method: 'supertrend'
        };

        this.sessionConfig = {
            enabled: false,
            allowedSessions: ['asia', 'london', 'newyork'],
            requirePeakHours: false,
            requireOverlap: false,
            blockWeekends: false
        };

        this.correlationConfig = {
            enabled: false,
            period: 20,
            minCorrelation: 0.5,
            blockOnDivergence: true
        };
    }

    /**
     * Reset internal state (used before backtests)
     */
    reset() {
        this.lastSignals = {};
        this.pendingAlignments = {};
        this.lastOrderBookAnalysis = {};
        this.lastSignalTime = null;
        this.lastSignalType = null;
        this.backtestMode = false;
    }

    /**
     * Configure signal engine settings
     * @param {object} settings - { cooldownMs, minConfidenceThreshold }
     */
    configure(settings) {
        if (settings.cooldownMs !== undefined) this.signalCooldownMs = settings.cooldownMs;
        if (settings.minConfidenceThreshold !== undefined) this.minConfidenceThreshold = settings.minConfidenceThreshold;

        // NEW: Configure advanced filters
        if (settings.indicatorWeights) {
            this.indicatorWeights = { ...this.indicatorWeights, ...settings.indicatorWeights };
        }
        if (settings.mtfConfig) {
            this.mtfConfig = { ...this.mtfConfig, ...settings.mtfConfig };
        }
        if (settings.sessionConfig) {
            this.sessionConfig = { ...this.sessionConfig, ...settings.sessionConfig };
        }
        if (settings.correlationConfig) {
            this.correlationConfig = { ...this.correlationConfig, ...settings.correlationConfig };
        }
    }

    /**
     * Process all indicators and generate signals
     * @param {object} data - Market data
     * @param {object} config - Indicator configurations
     * @param {object} currentPosition - Current position info
     * @returns {object} - Trading signals
     */
    processSignals(data, config, currentPosition) {
        const signals = {
            primary: null,       // 'long', 'short', or null
            secondaryPass: true, // All secondary filters pass
            closePosition: false,// Should close current position
            details: {},         // Individual indicator signals
            timestamp: Date.now(),
            // NEW: Enhanced signal info
            confidence: 0,       // 0-100 confidence score
            confidenceDetails: {},// Which indicators agree/disagree
            suggestedStopLoss: null,
            suggestedTakeProfit: null,
            currentATR: null,    // ATR for SL/TP calculations
            cooldownActive: false // True if in cooldown period
        };

        // Get OHLCV data for the configured market and timeframe
        const market1OHLCV = data.ohlcv?.market1 || [];
        const market2OHLCV = data.ohlcv?.market2 || [];
        const market1OB = data.orderbook?.market1 || null;
        const market2OB = data.orderbook?.market2 || null;

        // Early return if no config or no data
        if (!config || (market1OHLCV.length === 0 && market2OHLCV.length === 0)) {
            return signals;
        }

        // Process each indicator
        this.processSupertrendSignals(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processEMASignal(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processRSISignal(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processADXSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processVWAPSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processVolumeSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition);
        this.processOrderBookSignal(signals, market1OB, market2OB, config, currentPosition, data.currentPrice);

        // NEW: Process advanced filters
        this.processMTFFilter(signals, market1OHLCV, market2OHLCV, config);
        this.processSessionFilter(signals, data.timestamp);
        this.processCorrelationFilter(signals, market1OHLCV, market2OHLCV);

        // Aggregate secondary filters AND calculate WEIGHTED confidence
        const filterResult = this.checkSecondaryFiltersWithWeightedConfidence(signals, config);
        signals.secondaryPass = filterResult.allPass;
        signals.confidence = filterResult.confidence;
        signals.confidenceDetails = filterResult.details;
        signals.weightedDetails = filterResult.weightedDetails;

        // Check position protection
        if (currentPosition && currentPosition.type) {
            signals.closePosition = this.checkPositionProtection(signals, config, currentPosition);
        }

        // Apply alignment compensation for primary signals (skip in backtest mode)
        if (signals.primary && !signals.secondaryPass && !this.backtestMode) {
            const compensationMs = this.getMaxAlignmentCompensation(config, signals.primary);
            if (compensationMs > 0) {
                this.schedulePendingAlignment(signals.primary, compensationMs);
                signals.primary = null; // Wait for alignment
            }
        }

        // Check pending alignments
        const pendingSignal = this.checkPendingAlignments();
        if (pendingSignal && signals.secondaryPass) {
            signals.primary = pendingSignal;
        }

        // Apply cooldown check (prevent rapid flip-flopping)
        if (signals.primary) {
            const cooldownCheck = this.checkCooldown(signals.primary);
            if (cooldownCheck.blocked) {
                signals.cooldownActive = true;
                signals.cooldownRemaining = cooldownCheck.remainingMs;
                signals.primary = null; // Block signal due to cooldown
            }
        }

        // Apply minimum confidence threshold
        if (signals.primary && signals.confidence < this.minConfidenceThreshold) {
            signals.rejectedReason = `Confidence ${signals.confidence}% below threshold ${this.minConfidenceThreshold}%`;
            signals.primary = null;
        }

        // Extract ATR for SL/TP suggestions (from Supertrend if available)
        this.addSLTPSuggestions(signals, data, config);

        // Record signal for cooldown tracking
        if (signals.primary) {
            this.lastSignalTime = Date.now();
            this.lastSignalType = signals.primary;
        }

        return signals;
    }

    /**
     * Process Supertrend indicators (Slow, Fast, Cross Market)
     */
    processSupertrendSignals(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const supertrendTypes = ['slowSupertrend', 'fastSupertrend', 'crossMarketSupertrend'];

        for (const type of supertrendTypes) {
            const cfg = config[type];
            if (!cfg || cfg.enabled === 'off') continue;

            const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;

            // Debug: Log which market is being used
            console.log(`[SignalEngine] ${type}: market=${cfg.market}, dataLength=${ohlcv?.length || 0}, m1Len=${market1OHLCV?.length || 0}, m2Len=${market2OHLCV?.length || 0}`);

            const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

            const signal = getSupertrendSignal(
                resampledOHLCV,
                cfg.atrPeriod || 7,
                cfg.multiplier || 2,
                cfg.source || 'close'
            );

            signals.details[type] = signal;

            // Primary signal
            if (cfg.enabled === 'primary') {
                if (signal.trendChanged) {
                    if (signal.changeType === 'bullish') {
                        signals.primary = 'long';
                    } else if (signal.changeType === 'bearish') {
                        signals.primary = 'short';
                    }
                }
            }

            // Position protection
            if (cfg.positionProtection && currentPosition?.type) {
                if (currentPosition.type === 'long' && signal.trend === -1) {
                    signals.closePosition = true;
                } else if (currentPosition.type === 'short' && signal.trend === 1) {
                    signals.closePosition = true;
                }
            }
        }
    }

    /**
     * Process EMA signal
     */
    processEMASignal(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const cfg = config.ema200;
        if (!cfg || cfg.enabled === 'off') return;

        const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;
        const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

        const signal = getEMASignal(resampledOHLCV, cfg.length || 200, cfg.source || 'close');
        signals.details.ema200 = signal;

        // EMA has no primary signal

        // Position protection
        if (cfg.positionProtection && currentPosition?.type) {
            if (currentPosition.type === 'long' && signal.strongCrossBeyond && !signal.priceAboveEMA) {
                signals.closePosition = true;
            } else if (currentPosition.type === 'short' && signal.strongCrossBeyond && signal.priceAboveEMA) {
                signals.closePosition = true;
            }
        }
    }

    /**
     * Process RSI signal
     */
    processRSISignal(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const cfg = config.rsi;
        if (!cfg || cfg.enabled === 'off') return;

        const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;
        const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

        const signal = getRSISignal(
            resampledOHLCV,
            cfg.length || 14,
            cfg.overbought || 70,
            cfg.oversold || 30
        );
        signals.details.rsi = signal;

        // Primary signals
        if (cfg.enabled === 'primary') {
            if (signal.primaryLong) signals.primary = 'long';
            else if (signal.primaryShort) signals.primary = 'short';
        }

        // Position protection
        if (cfg.positionProtection && currentPosition?.type) {
            if (currentPosition.type === 'long' && signal.protectionCloseLong) {
                signals.closePosition = true;
            } else if (currentPosition.type === 'short' && signal.protectionCloseShort) {
                signals.closePosition = true;
            }
        }
    }

    /**
     * Process ADX signal
     */
    processADXSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const cfg = config.adx;
        if (!cfg || cfg.enabled === 'off') return;

        const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;
        const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

        const signal = getADXSignal(
            resampledOHLCV,
            cfg.length || 14,
            cfg.secondarySetpoint || 20,
            cfg.protectionThreshold || 30
        );
        signals.details.adx = signal;

        // ADX has no primary signal

        // Position protection
        if (cfg.positionProtection && currentPosition?.type && signal.protectionClose) {
            signals.closePosition = true;
        }
    }

    /**
     * Process VWAP signal
     */
    processVWAPSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const cfg = config.vwap;
        if (!cfg || cfg.enabled === 'off') return;

        const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;
        const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

        const signal = getVWAPSignal(resampledOHLCV, cfg.source || 'typical', cfg.bands || [1, 2]);
        signals.details.vwap = signal;

        // Primary signals
        if (cfg.enabled === 'primary') {
            if (signal.primaryLong) signals.primary = 'long';
            else if (signal.primaryShort) signals.primary = 'short';
        }

        // Position protection
        if (cfg.positionProtection && currentPosition?.type) {
            if (currentPosition.type === 'long' && signal.protectionCloseLong) {
                signals.closePosition = true;
            } else if (currentPosition.type === 'short' && signal.protectionCloseShort) {
                signals.closePosition = true;
            }
        }
    }

    /**
     * Process Volume signal
     */
    processVolumeSignal(signals, market1OHLCV, market2OHLCV, config, currentPosition) {
        const cfg = config.volume;
        if (!cfg || cfg.enabled === 'off') return;

        const ohlcv = cfg.market === 1 ? market1OHLCV : market2OHLCV;
        const resampledOHLCV = this.resampleOHLCV(ohlcv, cfg.timeframe || 1);

        const signal = getVolumeSignal(
            resampledOHLCV,
            cfg.maLength || 20,
            cfg.confirmationMultiplier || 1.0,
            cfg.againstMultiplier || 1.5
        );
        signals.details.volume = signal;

        // Primary signals: volume spike + candle direction
        if (cfg.enabled === 'primary') {
            if (signal.primaryLong) signals.primary = 'long';
            else if (signal.primaryShort) signals.primary = 'short';
        }

        // Position protection
        if (cfg.positionProtection && currentPosition?.type) {
            if (currentPosition.type === 'long' && signal.protectionCloseLong) {
                signals.closePosition = true;
            } else if (currentPosition.type === 'short' && signal.protectionCloseShort) {
                signals.closePosition = true;
            }
        }
    }

    /**
     * Process Order Book signal
     */
    processOrderBookSignal(signals, market1OB, market2OB, config, currentPosition, currentPrice) {
        const cfg = config.orderBook;
        if (!cfg || cfg.enabled === 'off') return;

        const orderbook = cfg.market === 1 ? market1OB : market2OB;
        const prevAnalysis = this.lastOrderBookAnalysis[cfg.market] || null;

        const signal = getOrderBookSignal(
            orderbook,
            prevAnalysis,
            currentPrice,
            cfg.depth || 50,
            cfg.imbalanceThreshold || 60
        );
        signals.details.orderBook = signal;

        // Store for next comparison
        this.lastOrderBookAnalysis[cfg.market] = signal;

        // Primary signals
        if (cfg.enabled === 'primary') {
            if (signal.primaryLong) signals.primary = 'long';
            else if (signal.primaryShort) signals.primary = 'short';
        }

        // Position protection
        if (cfg.positionProtection && currentPosition?.type) {
            if (currentPosition.type === 'long' && signal.protectionCloseLong) {
                signals.closePosition = true;
            } else if (currentPosition.type === 'short' && signal.protectionCloseShort) {
                signals.closePosition = true;
            }
        }
    }

    /**
     * Process MTF (Multi-Timeframe) Filter
     */
    processMTFFilter(signals, market1OHLCV, market2OHLCV, config) {
        if (!this.mtfConfig.enabled) return;

        const primaryMarket = config.slowSupertrend?.market || 1;
        const ohlcv = primaryMarket === 1 ? market1OHLCV : market2OHLCV;

        const signal = getMTFSignal(ohlcv, {
            baseInterval: config.baseInterval || '1m',
            timeframes: this.mtfConfig.timeframes,
            minAlignmentScore: this.mtfConfig.minAlignmentScore,
            method: this.mtfConfig.method
        });

        signals.details.mtf = signal;
    }

    /**
     * Process Session Filter
     */
    processSessionFilter(signals, timestamp) {
        if (!this.sessionConfig.enabled) return;

        const signal = getSessionSignal(this.sessionConfig, timestamp || Date.now());
        signals.details.session = signal;
    }

    /**
     * Process Correlation Filter
     */
    processCorrelationFilter(signals, market1OHLCV, market2OHLCV) {
        if (!this.correlationConfig.enabled) return;

        if (!market1OHLCV?.length || !market2OHLCV?.length) return;

        const signal = getCorrelationSignal(market1OHLCV, market2OHLCV, {
            period: this.correlationConfig.period,
            minCorrelation: this.correlationConfig.minCorrelation,
            blockOnDivergence: this.correlationConfig.blockOnDivergence
        });

        signals.details.correlation = signal;
    }

    /**
     * Check secondary filters with WEIGHTED confidence scoring
     * Returns { allPass, confidence, details, weightedDetails }
     */
    checkSecondaryFiltersWithWeightedConfidence(signals, config) {
        let totalWeight = 0;
        let agreeingWeight = 0;
        const details = {};
        const weightedDetails = {};

        // All indicators that can be secondary
        const indicators = [
            'slowSupertrend', 'fastSupertrend', 'crossMarketSupertrend',
            'ema200', 'rsi', 'adx', 'vwap', 'volume', 'orderBook',
            'mtf', 'session', 'correlation'
        ];

        for (const indicator of indicators) {
            const cfg = config[indicator];
            const signal = signals.details[indicator];

            // For new filters, check if enabled in their respective config
            let isSecondary = false;
            if (['mtf', 'session', 'correlation'].includes(indicator)) {
                const filterConfig = this[`${indicator}Config`];
                isSecondary = filterConfig?.enabled;
            } else {
                isSecondary = cfg?.enabled === 'secondary';
            }

            if (!isSecondary || !signal) continue;

            const weight = this.indicatorWeights[indicator] || 5;
            totalWeight += weight;

            // Check if secondary allows the intended trade
            let allows = true;
            if (signals.primary === 'long') {
                if (signal.secondaryLong !== undefined) {
                    allows = signal.secondaryLong;
                } else if (signal.allowsLong !== undefined) {
                    allows = signal.allowsLong;
                } else if (signal.allowed !== undefined) {
                    allows = signal.allowed;
                } else if (signal.trend !== undefined) {
                    allows = signal.trend === 1;
                } else if (signal.bullish !== undefined) {
                    allows = signal.bullish;
                }
            } else if (signals.primary === 'short') {
                if (signal.secondaryShort !== undefined) {
                    allows = signal.secondaryShort;
                } else if (signal.allowsShort !== undefined) {
                    allows = signal.allowsShort;
                } else if (signal.allowed !== undefined) {
                    allows = signal.allowed;
                } else if (signal.trend !== undefined) {
                    allows = signal.trend === -1;
                } else if (signal.bearish !== undefined) {
                    allows = signal.bearish;
                }
            }

            if (allows) {
                agreeingWeight += weight;
                details[indicator] = 'agree';
            } else {
                details[indicator] = 'disagree';
            }

            weightedDetails[indicator] = { weight, allows };
        }

        const confidence = totalWeight > 0
            ? Math.round((agreeingWeight / totalWeight) * 100)
            : 100;
        const allPass = totalWeight === 0 || agreeingWeight === totalWeight;

        return {
            allPass,
            confidence,
            agreeingWeight,
            totalWeight,
            details,
            weightedDetails
        };
    }

    /**
     * Check secondary filters with confidence scoring (legacy method)
     * Returns { allPass, confidence, details }
     */
    checkSecondaryFiltersWithConfidence(signals, config) {
        let agreeing = 0;
        let disagreeing = 0;
        const details = {};

        // Check each indicator configured as secondary
        const secondaryIndicators = [
            'slowSupertrend', 'fastSupertrend', 'crossMarketSupertrend',
            'ema200', 'rsi', 'adx', 'vwap', 'volume', 'orderBook'
        ];

        for (const indicator of secondaryIndicators) {
            const cfg = config[indicator];
            if (!cfg || cfg.enabled !== 'secondary') continue;

            const signal = signals.details[indicator];
            if (!signal) continue;

            // Check if secondary allows the intended trade
            let allows = true;
            if (signals.primary === 'long') {
                if (signal.secondaryLong !== undefined) {
                    allows = signal.secondaryLong;
                } else if (signal.trend !== undefined) {
                    allows = signal.trend === 1;
                } else if (signal.bullish !== undefined) {
                    allows = signal.bullish;
                }
            } else if (signals.primary === 'short') {
                if (signal.secondaryShort !== undefined) {
                    allows = signal.secondaryShort;
                } else if (signal.trend !== undefined) {
                    allows = signal.trend === -1;
                } else if (signal.bearish !== undefined) {
                    allows = signal.bearish;
                }
            }

            // Track for confidence scoring
            if (allows) {
                agreeing++;
                details[indicator] = 'agree';
            } else {
                disagreeing++;
                details[indicator] = 'disagree';
            }
        }

        const total = agreeing + disagreeing;
        const confidence = total > 0 ? Math.round((agreeing / total) * 100) : 100;
        const allPass = disagreeing === 0;

        return {
            allPass,
            confidence,
            agreeing,
            disagreeing,
            total,
            details
        };
    }

    /**
     * Legacy method for backwards compatibility
     */
    checkSecondaryFilters(signals, config) {
        return this.checkSecondaryFiltersWithConfidence(signals, config).allPass;
    }

    /**
     * Check cooldown between opposite signals
     * @param {string} signalType - 'long' or 'short'
     * @returns {object} - { blocked, remainingMs }
     */
    checkCooldown(signalType) {
        if (!this.lastSignalTime || !this.lastSignalType) {
            return { blocked: false, remainingMs: 0 };
        }

        // Skip cooldown in backtest mode (Date.now() is meaningless in synchronous simulation)
        if (this.backtestMode) {
            return { blocked: false, remainingMs: 0 };
        }

        // Only apply cooldown for opposite signals (prevent flip-flop)
        if (signalType === this.lastSignalType) {
            return { blocked: false, remainingMs: 0 };
        }

        const elapsed = Date.now() - this.lastSignalTime;
        if (elapsed < this.signalCooldownMs) {
            return {
                blocked: true,
                remainingMs: this.signalCooldownMs - elapsed
            };
        }

        return { blocked: false, remainingMs: 0 };
    }

    /**
     * Add SL/TP suggestions based on ATR from indicators
     */
    addSLTPSuggestions(signals, data, config) {
        // Try to get ATR from Supertrend signals
        let atr = null;
        const stTypes = ['slowSupertrend', 'fastSupertrend', 'crossMarketSupertrend'];

        for (const stType of stTypes) {
            if (signals.details[stType]?.atr) {
                atr = signals.details[stType].atr;
                break;
            }
        }

        if (!atr || !signals.primary) return;

        signals.currentATR = atr;
        const currentPrice = data.currentPrice || signals.details.slowSupertrend?.currentPrice;

        if (!currentPrice) return;

        // Default: 1.5x ATR for SL, 2:1 R:R for TP
        const slMultiplier = config.riskSettings?.atrMultiplier || 1.5;
        const rrRatio = config.riskSettings?.riskRewardRatio || 2.0;

        if (signals.primary === 'long') {
            signals.suggestedStopLoss = currentPrice - (atr * slMultiplier);
            signals.suggestedTakeProfit = currentPrice + (atr * slMultiplier * rrRatio);
        } else {
            signals.suggestedStopLoss = currentPrice + (atr * slMultiplier);
            signals.suggestedTakeProfit = currentPrice - (atr * slMultiplier * rrRatio);
        }
    }

    /**
     * Check position protection triggers
     */
    checkPositionProtection(signals, config, currentPosition) {
        // Already set by individual indicators
        return signals.closePosition;
    }

    /**
     * Schedule pending alignment
     */
    schedulePendingAlignment(signalType, compensationMs) {
        this.pendingAlignments[signalType] = {
            timestamp: Date.now(),
            expiresAt: Date.now() + compensationMs,
            type: signalType
        };
    }

    /**
     * Check pending alignments
     */
    checkPendingAlignments() {
        const now = Date.now();

        for (const [type, alignment] of Object.entries(this.pendingAlignments)) {
            if (now <= alignment.expiresAt) {
                // Still valid, return and consume
                delete this.pendingAlignments[type];
                return type;
            } else {
                // Expired, remove
                delete this.pendingAlignments[type];
            }
        }

        return null;
    }

    /**
     * Get max alignment compensation from config
     */
    getMaxAlignmentCompensation(config, signalType) {
        let maxCompensation = 0;

        const indicatorsWithCompensation = [
            'slowSupertrend', 'fastSupertrend', 'crossMarketSupertrend'
        ];

        for (const indicator of indicatorsWithCompensation) {
            const cfg = config[indicator];
            if (cfg && cfg.enabled === 'secondary' && cfg.alignmentCompensation) {
                maxCompensation = Math.max(maxCompensation, cfg.alignmentCompensation);
            }
        }

        return maxCompensation;
    }

    /**
     * Resample OHLCV to higher timeframe
     */
    resampleOHLCV(ohlcv, timeframeMinutes) {
        if (!ohlcv || ohlcv.length === 0 || timeframeMinutes <= 1) return ohlcv || [];

        const tfMs = timeframeMinutes * 60 * 1000;
        const resampled = [];
        let currentBar = null;

        for (const candle of ohlcv) {
            const barStart = Math.floor(candle.timestamp / tfMs) * tfMs;

            if (!currentBar || currentBar.timestamp !== barStart) {
                if (currentBar) resampled.push(currentBar);
                currentBar = {
                    timestamp: barStart,
                    open: candle.open,
                    high: candle.high,
                    low: candle.low,
                    close: candle.close,
                    volume: candle.volume
                };
            } else {
                currentBar.high = Math.max(currentBar.high, candle.high);
                currentBar.low = Math.min(currentBar.low, candle.low);
                currentBar.close = candle.close;
                currentBar.volume += candle.volume;
            }
        }

        if (currentBar) resampled.push(currentBar);
        return resampled;
    }
}

// Singleton instance
const signalEngine = new SignalEngine();

export default signalEngine;
export { SignalEngine };
