// ================================================
// NEXUS TRADING TERMINAL - AI INDICATOR
// Autonomous scalping engine: market context +
// regime detection + multi-indicator confluence
// ================================================

import { calculateSupertrend } from './supertrend.js';
import { calculateRSI } from './rsi.js';
import { calculateEMA } from './ema.js';
import { calculateVWAP } from './vwap.js';
import { calculateADX } from './adx.js';
import { calculateVolumeAnalysis } from './volume.js';

// ============================================================
// CONSTANTS
// ============================================================

const FAPI_BASE = 'https://fapi.binance.com';
const PKT_OFFSET = 5;

// Scalping-optimized indicator parameters
const SCALP_PARAMS = {
    supertrend: { atrPeriod: 3, multiplier: 1.0 },
    ema: { length: 21 },
    rsi: { length: 7, overbought: 70, oversold: 30 },
    vwap: { source: 'typical', bands: [1, 2] },
    adx: { length: 10 },
    volume: { maLength: 10, spikeThreshold: 1.5 }
};

// Regime thresholds
const REGIME = {
    TRENDING_UP: 'TRENDING_UP',
    TRENDING_DOWN: 'TRENDING_DOWN',
    RANGING: 'RANGING',
    VOLATILE: 'VOLATILE'
};

// Session data (PKT hours)
const SESSIONS = [
    { name: 'Sydney', openPKT: 2, closePKT: 9, volScore: 25 },
    { name: 'Tokyo', openPKT: 4, closePKT: 13, volScore: 45 },
    { name: 'London', openPKT: 13, closePKT: 22, volScore: 72 },
    { name: 'NewYork', openPKT: 18, closePKT: 3, volScore: 90 }
];

// ============================================================
// AI MARKET CONTEXT — Fetches real-time market data
// ============================================================

class AIMarketContext {
    constructor() {
        this.cache = {
            funding: null,
            oi: null,
            ls: null,
            microVol: null,
            sentiment: null,
            lastFetch: 0
        };
        this.refreshInterval = 30000; // 30 seconds default
    }

    /**
     * Configure refresh interval
     */
    configure(config) {
        if (config.contextRefreshInterval) {
            this.refreshInterval = config.contextRefreshInterval;
        }
    }

    /**
     * Check if cache is stale
     */
    isStale() {
        return (Date.now() - this.cache.lastFetch) > this.refreshInterval;
    }

    /**
     * Fetch with retry and rate limit handling
     */
    async fetchWithRetry(url, retries = 3, delay = 1000) {
        for (let i = 0; i < retries; i++) {
            try {
                const res = await fetch(url);
                if (res.status === 429) {
                    console.warn(`[AI] Rate limit on ${url}, retrying in ${delay}ms...`);
                    await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
                    continue;
                }
                if (!res.ok) throw new Error(`HTTP ${res.status}`);
                return await res.json();
            } catch (err) {
                if (i === retries - 1) throw err;
                await new Promise(r => setTimeout(r, delay * Math.pow(2, i)));
            }
        }
    }

    /**
     * Fetch all market context data
     */
    async fetchAll(symbol = 'BTCUSDT') {
        if (!this.isStale()) {
            return this.cache;
        }

        try {
            const [funding, oi, ls, microVol, sentiment] = await Promise.all([
                this.fetchFundingRate(symbol),
                this.fetchOpenInterest(symbol),
                this.fetchLongShortRatio(symbol),
                this.fetchMicroVolatility(symbol),
                this.fetchSentiment()
            ]);

            this.cache = {
                funding,
                oi,
                ls,
                microVol,
                sentiment,
                session: this.getActiveSession(),
                scalpScore: this.calculateScalpScore(funding, oi, ls, microVol),
                lastFetch: Date.now()
            };

            return this.cache;
        } catch (err) {
            console.warn('[AI] Context fetch failed:', err.message);
            return this.cache; // Return stale cache
        }
    }

    /**
     * Fetch funding rate from premium index
     */
    async fetchFundingRate(symbol) {
        try {
            const data = await this.fetchWithRetry(
                `${FAPI_BASE}/fapi/v1/premiumIndex?symbol=${symbol}`
            );
            const rate = parseFloat(data.lastFundingRate);
            const ratePct = rate * 100;
            return {
                rate,
                ratePct: ratePct.toFixed(4),
                absRate: Math.abs(ratePct),
                direction: rate > 0 ? 'longs-pay' : 'shorts-pay',
                isExtreme: Math.abs(ratePct) >= 0.1,
                isHigh: Math.abs(ratePct) >= 0.05,
                nextFundingTime: data.nextFundingTime,
                markPrice: parseFloat(data.markPrice)
            };
        } catch (err) {
            console.warn('[AI] Funding fetch failed:', err.message);
            return null;
        }
    }

    /**
     * Fetch Crypto Fear and Greed Index
     */
    async fetchSentiment() {
        try {
            const res = await this.fetchWithRetry('https://api.alternative.me/fng/?limit=1');
            if (res && res.data && res.data.length > 0) {
                const value = parseInt(res.data[0].value);
                const classification = res.data[0].value_classification;
                return {
                    score: value,
                    classification: classification,
                    isExtremeGreed: value >= 75,
                    isExtremeFear: value <= 25
                };
            }
            return null;
        } catch (err) {
            console.warn('[AI] Sentiment fetch failed:', err.message);
            return null;
        }
    }

    /**
     * Fetch open interest
     */
    async fetchOpenInterest(symbol) {
        try {
            const data = await this.fetchWithRetry(
                `${FAPI_BASE}/fapi/v1/openInterest?symbol=${symbol}`
            );
            const oi = parseFloat(data.openInterest);
            const prevOI = this.cache.oi?.oi || oi;
            const change = prevOI > 0 ? ((oi - prevOI) / prevOI * 100) : 0;

            return {
                oi,
                change: change.toFixed(2),
                changePct: change,
                isSurging: Math.abs(change) > 2,
                isShifting: Math.abs(change) > 0.5,
                direction: change > 0.1 ? 'up' : change < -0.1 ? 'down' : 'flat'
            };
        } catch (err) {
            console.warn('[AI] OI fetch failed:', err.message);
            return null;
        }
    }

    /**
     * Fetch long/short ratio
     */
    async fetchLongShortRatio(symbol) {
        try {
            const data = await this.fetchWithRetry(
                `${FAPI_BASE}/futures/data/globalLongShortAccountRatio?symbol=${symbol}&period=5m&limit=1`
            );
            if (!data || data.length === 0) return null;

            const d = data[0];
            const ratio = parseFloat(d.longShortRatio);

            return {
                longPct: (parseFloat(d.longAccount) * 100).toFixed(1),
                shortPct: (parseFloat(d.shortAccount) * 100).toFixed(1),
                ratio: ratio.toFixed(3),
                ratioNum: ratio,
                isLongHeavy: ratio > 1.5,
                isShortHeavy: ratio < 0.67,
                isExtreme: ratio > 2.0 || ratio < 0.5,
                squeezeRisk: ratio > 2.0 ? 'long-squeeze' : ratio < 0.5 ? 'short-squeeze' : 'none'
            };
        } catch (err) {
            console.warn('[AI] L/S ratio fetch failed:', err.message);
            return null;
        }
    }

    /**
     * Fetch micro-volatility from 1m klines
     */
    async fetchMicroVolatility(symbol) {
        try {
            const data = await this.fetchWithRetry(
                `${FAPI_BASE}/fapi/v1/klines?symbol=${symbol}&interval=1m&limit=20`
            );

            if (!data || data.length < 3) return null;

            // Compute volatility from candle ranges
            const ranges = data.map(k => {
                const high = parseFloat(k[2]);
                const low = parseFloat(k[3]);
                const close = parseFloat(k[4]);
                return ((high - low) / close) * 100;
            });

            const avgRange = ranges.reduce((a, b) => a + b, 0) / ranges.length;
            const volScore = Math.min(100, Math.round(avgRange * 200));

            // Volume spike detection
            const volumes = data.map(k => parseFloat(k[5]));
            const recentVol = volumes[volumes.length - 1];
            const avgPrevVol = volumes.slice(0, -1).reduce((a, b) => a + b, 0) / (volumes.length - 1);
            const volumeSpike = recentVol > avgPrevVol * 2;

            let level;
            if (volScore >= 80) level = 'EXTREME';
            else if (volScore >= 60) level = 'HIGH';
            else if (volScore >= 40) level = 'MODERATE';
            else if (volScore >= 20) level = 'LOW';
            else level = 'DEAD';

            return {
                score: volScore,
                level,
                volumeSpike,
                avgRange: avgRange.toFixed(4),
                isScalpable: volScore >= 20 && volScore <= 80
            };
        } catch (err) {
            console.warn('[AI] MicroVol fetch failed:', err.message);
            return null;
        }
    }

    /**
     * Get currently active trading session
     */
    getActiveSession() {
        const now = new Date();
        const pktHour = (now.getUTCHours() + PKT_OFFSET) % 24;

        const active = [];
        for (const s of SESSIONS) {
            let isActive;
            if (s.closePKT > s.openPKT) {
                isActive = pktHour >= s.openPKT && pktHour < s.closePKT;
            } else {
                isActive = pktHour >= s.openPKT || pktHour < s.closePKT;
            }
            if (isActive) active.push(s);
        }

        // Determine best session for scalping
        const bestSession = active.sort((a, b) => b.volScore - a.volScore)[0] || null;
        const isOptimalHours = pktHour >= 13 && pktHour <= 22; // London + US overlap
        const isPeakHours = pktHour >= 17 && pktHour <= 22; // US session
        const isDeadHours = pktHour >= 0 && pktHour <= 4;

        return {
            activeSessions: active.map(s => s.name),
            bestSession: bestSession?.name || 'None',
            bestVolScore: bestSession?.volScore || 0,
            isOptimalHours,
            isPeakHours,
            isDeadHours,
            pktHour
        };
    }

    /**
     * Calculate scalp score (0-100)
     */
    calculateScalpScore(funding, oi, ls, microVol) {
        let score = 50;

        // Micro volatility contribution
        if (microVol) {
            if (microVol.score >= 60) score += 15;
            else if (microVol.score >= 40) score += 8;
            else if (microVol.score < 20) score -= 15;
            if (microVol.volumeSpike) score += 10;
        }

        // Funding contribution
        if (funding) {
            if (funding.absRate >= 0.05) score += 10;
            if (funding.isExtreme) score += 5;
        }

        // OI contribution
        if (oi) {
            if (oi.isSurging) score += 10;
            else if (oi.isShifting) score += 5;
        }

        // Session contribution
        const session = this.getActiveSession();
        if (session.isPeakHours) score += 10;
        else if (session.isOptimalHours) score += 5;
        else if (session.isDeadHours) score -= 10;

        return Math.max(0, Math.min(100, Math.round(score)));
    }

    /**
     * Get cached context without fetching
     */
    getCachedContext() {
        return this.cache;
    }

    /**
     * Reset cache (for testing)
     */
    reset() {
        this.cache = {
            funding: null,
            oi: null,
            ls: null,
            microVol: null,
            lastFetch: 0
        };
    }
}


// ============================================================
// AI REGIME DETECTOR
// ============================================================

class AIRegimeDetector {
    /**
     * Detect market regime from OHLCV data
     * @param {Array} ohlcv - OHLCV data
     * @param {object} context - Market context from AIMarketContext
     * @returns {object} - { regime, confidence, details }
     */
    detect(ohlcv, context) {
        if (!ohlcv || ohlcv.length < 30) {
            return { regime: REGIME.RANGING, confidence: 0, details: 'Insufficient data' };
        }

        // Calculate core indicators for regime detection
        const prices = ohlcv.map(c => c.close);
        const emaValues = calculateEMA(prices, SCALP_PARAMS.ema.length);
        const rsiValues = calculateRSI(prices, SCALP_PARAMS.rsi.length);
        const adxResult = calculateADX(ohlcv, SCALP_PARAMS.adx.length);

        const len = ohlcv.length;
        const currentPrice = prices[len - 1];
        const currentEMA = emaValues[len - 1];
        const currentRSI = rsiValues[len - 1];

        // Get latest ADX value
        let currentADX = null;
        let currentPlusDI = null;
        let currentMinusDI = null;
        if (adxResult.adx.length > 0) {
            // Find last non-null ADX value
            for (let i = adxResult.adx.length - 1; i >= 0; i--) {
                if (adxResult.adx[i] !== null) {
                    currentADX = adxResult.adx[i];
                    currentPlusDI = adxResult.plusDI[i];
                    currentMinusDI = adxResult.minusDI[i];
                    break;
                }
            }
        }

        // Micro-volatility from context
        const microVolScore = context?.microVol?.score || 40;
        const oiSurging = context?.oi?.isSurging || false;

        // ---- Regime Classification Logic ----

        const priceAboveEMA = currentEMA !== null && currentPrice > currentEMA;
        const strongADX = currentADX !== null && currentADX > 25;
        const weakADX = currentADX !== null && currentADX < 20;
        const rsiAbove55 = currentRSI !== null && currentRSI > 55;
        const rsiBelow45 = currentRSI !== null && currentRSI < 45;
        const rsiNeutral = currentRSI !== null && currentRSI >= 40 && currentRSI <= 60;
        const highVol = microVolScore >= 60;

        let regime = REGIME.RANGING;
        let confidence = 50;
        const reasons = [];

        // VOLATILE: High vol with no clear direction
        if (highVol && weakADX && oiSurging) {
            regime = REGIME.VOLATILE;
            confidence = 70 + (microVolScore - 60); // 70-110, capped to 100
            reasons.push(`Micro-vol=${microVolScore}, ADX=${currentADX?.toFixed(1)}, OI surging`);
        }
        // TRENDING_UP: Strong bullish
        else if (priceAboveEMA && strongADX && rsiAbove55 && currentPlusDI > currentMinusDI) {
            regime = REGIME.TRENDING_UP;
            confidence = 60 + Math.min(40, (currentADX - 25) * 3);
            reasons.push(`Price>EMA21, ADX=${currentADX?.toFixed(1)}, RSI=${currentRSI?.toFixed(1)}, +DI>-DI`);
        }
        // TRENDING_DOWN: Strong bearish
        else if (!priceAboveEMA && strongADX && rsiBelow45 && currentMinusDI > currentPlusDI) {
            regime = REGIME.TRENDING_DOWN;
            confidence = 60 + Math.min(40, (currentADX - 25) * 3);
            reasons.push(`Price<EMA21, ADX=${currentADX?.toFixed(1)}, RSI=${currentRSI?.toFixed(1)}, -DI>+DI`);
        }
        // RANGING: No clear direction
        else if (weakADX && rsiNeutral) {
            regime = REGIME.RANGING;
            confidence = 60 + Math.min(40, (20 - (currentADX || 15)) * 5);
            reasons.push(`ADX=${currentADX?.toFixed(1)}<20, RSI=${currentRSI?.toFixed(1)} neutral`);
        }
        // Partial trending - weaker signals
        else if (priceAboveEMA && rsiAbove55) {
            regime = REGIME.TRENDING_UP;
            confidence = 45;
            reasons.push(`Weak uptrend: Price>EMA21, RSI=${currentRSI?.toFixed(1)}`);
        }
        else if (!priceAboveEMA && rsiBelow45) {
            regime = REGIME.TRENDING_DOWN;
            confidence = 45;
            reasons.push(`Weak downtrend: Price<EMA21, RSI=${currentRSI?.toFixed(1)}`);
        }
        else {
            // Default RANGING
            regime = REGIME.RANGING;
            confidence = 40;
            reasons.push(`No clear regime detected`);
        }

        confidence = Math.max(0, Math.min(100, Math.round(confidence)));

        return {
            regime,
            confidence,
            details: reasons.join('; '),
            indicators: {
                price: currentPrice,
                ema21: currentEMA,
                rsi: currentRSI,
                adx: currentADX,
                plusDI: currentPlusDI,
                minusDI: currentMinusDI,
                microVol: microVolScore
            }
        };
    }
}


// ============================================================
// AI CONFLUENCE ENGINE — Runs 6 internal indicators
// ============================================================

class AIConfluenceEngine {
    /**
     * Run all internal indicators and compute confluence
     * @param {Array} ohlcv - OHLCV data
     * @param {string} regime - Current market regime
     * @param {object} context - Market context
     * @returns {object} - confluence result
     */
    analyze(ohlcv, regime, context) {
        if (!ohlcv || ohlcv.length < 30) {
            return this.emptyResult();
        }

        const len = ohlcv.length;
        const prices = ohlcv.map(c => c.close);
        const currentPrice = prices[len - 1];

        // --- ADAPTIVE PARAMETERS (ML Layer) ---
        const params = JSON.parse(JSON.stringify(SCALP_PARAMS));
        
        // Adapt based on Regime
        if (regime === REGIME.VOLATILE) {
            params.supertrend.multiplier = 1.5; 
            params.rsi.overbought = 75;
            params.rsi.oversold = 25;
            params.volume.spikeThreshold = 2.0;
        } else if (regime === REGIME.TRENDING_UP) {
            params.rsi.overbought = 80;
            params.rsi.oversold = 40;
            params.supertrend.multiplier = 1.2;
        } else if (regime === REGIME.TRENDING_DOWN) {
            params.rsi.overbought = 60;
            params.rsi.oversold = 20;
            params.supertrend.multiplier = 1.2;
        }

        // Adapt based on Sentiment
        if (context && context.sentiment) {
             if (context.sentiment.isExtremeGreed && regime === REGIME.TRENDING_UP) {
                 params.supertrend.multiplier = 0.8; // tighten stops on extreme greed
             } else if (context.sentiment.isExtremeFear && regime === REGIME.TRENDING_DOWN) {
                 params.supertrend.multiplier = 0.8; // tighten stops on extreme fear
             }
        }

        // ---- Run all 6 indicators ----

        // 1. Supertrend (ATR=3, Mult varies) — Fast trend for 1m
        const stResult = calculateSupertrend(
            ohlcv,
            params.supertrend.atrPeriod,
            params.supertrend.multiplier,
            'close'
        );
        const stDirection = stResult.direction.length > 0 ? stResult.direction[stResult.direction.length - 1] : 0;
        const stPrevDir = stResult.direction.length > 1 ? stResult.direction[stResult.direction.length - 2] : 0;
        const stFlipped = stDirection !== stPrevDir && stPrevDir !== 0;
        const stATR = stResult.atr ? stResult.atr[stResult.atr.length - 1] : null;

        // 2. EMA(21) — Short-term trend filter
        const emaValues = calculateEMA(prices, params.ema.length);
        const currentEMA = emaValues[len - 1];
        const priceAboveEMA = currentEMA !== null && currentPrice > currentEMA;
        // EMA slope
        const prevEMA = emaValues.length > 1 ? emaValues[len - 2] : null;
        const emaSlopeUp = currentEMA !== null && prevEMA !== null && currentEMA > prevEMA;

        // 3. RSI(7) — Rapid momentum
        const rsiValues = calculateRSI(prices, params.rsi.length);
        const currentRSI = rsiValues[len - 1];
        const prevRSI = rsiValues.length > 1 ? rsiValues[len - 2] : null;

        // 4. VWAP — Mean-reversion levels
        const vwapResult = calculateVWAP(ohlcv, params.vwap.source, params.vwap.bands);
        const currentVWAP = vwapResult.vwap.length > 0 ? vwapResult.vwap[vwapResult.vwap.length - 1] : null;
        const vwapUpper1 = vwapResult.upperBand1.length > 0 ? vwapResult.upperBand1[vwapResult.upperBand1.length - 1] : null;
        const vwapLower1 = vwapResult.lowerBand1.length > 0 ? vwapResult.lowerBand1[vwapResult.lowerBand1.length - 1] : null;
        const priceAboveVWAP = currentVWAP !== null && currentPrice > currentVWAP;

        // 5. ADX(10) — Trend strength
        const adxResult = calculateADX(ohlcv, params.adx.length);
        let currentADX = null;
        let plusDI = null;
        let minusDI = null;
        if (adxResult.adx.length > 0) {
            for (let i = adxResult.adx.length - 1; i >= 0; i--) {
                if (adxResult.adx[i] !== null) {
                    currentADX = adxResult.adx[i];
                    plusDI = adxResult.plusDI[i];
                    minusDI = adxResult.minusDI[i];
                    break;
                }
            }
        }

        // 6. Volume — Confirmation
        const volResult = calculateVolumeAnalysis(ohlcv, params.volume.maLength);
        let volumeRatio = null;
        let volumeSpike = false;
        let isBullishCandle = false;
        let isBearishCandle = false;
        if (volResult.volumeRatio && volResult.volumeRatio.length > 0) {
            volumeRatio = volResult.volumeRatio[volResult.volumeRatio.length - 1];
            volumeSpike = volumeRatio !== null && volumeRatio >= params.volume.spikeThreshold;
        }
        if (ohlcv.length > 0) {
            const lastCandle = ohlcv[len - 1];
            isBullishCandle = lastCandle.close > lastCandle.open;
            isBearishCandle = lastCandle.close < lastCandle.open;
        }

        // ---- Vote System ----
        // Each indicator votes: +1 for bullish, -1 for bearish, 0 for neutral

        const votes = [];
        const voteDetails = {};

        // 1. Supertrend vote
        const stVote = stDirection === 1 ? 1 : stDirection === -1 ? -1 : 0;
        votes.push(stVote);
        voteDetails.supertrend = {
            vote: stVote,
            reason: stVote === 1 ? 'Uptrend' : stVote === -1 ? 'Downtrend' : 'No trend',
            flipped: stFlipped,
            atr: stATR
        };

        // 2. EMA vote
        let emaVote = 0;
        if (priceAboveEMA && emaSlopeUp) emaVote = 1;
        else if (!priceAboveEMA && !emaSlopeUp) emaVote = -1;
        votes.push(emaVote);
        voteDetails.ema = {
            vote: emaVote,
            reason: emaVote === 1 ? 'Price>EMA↑' : emaVote === -1 ? 'Price<EMA↓' : 'Mixed',
            value: currentEMA
        };

        // 3. RSI vote — regime-dependent
        let rsiVote = 0;
        if (regime === REGIME.TRENDING_UP) {
            // In uptrend, RSI pullback to 45-55 = buy signal
            if (currentRSI >= 45 && currentRSI <= 55 && prevRSI !== null && prevRSI > 55) rsiVote = 1;
            // RSI > 55 = confirming uptrend
            else if (currentRSI > 55) rsiVote = 1;
            // RSI < 40 = trend exhaustion
            else if (currentRSI < 40) rsiVote = -1;
        } else if (regime === REGIME.TRENDING_DOWN) {
            if (currentRSI >= 45 && currentRSI <= 55 && prevRSI !== null && prevRSI < 45) rsiVote = -1;
            else if (currentRSI < 45) rsiVote = -1;
            else if (currentRSI > 60) rsiVote = 1;
        } else if (regime === REGIME.RANGING) {
            // Range: fade extremes
            if (currentRSI <= 30) rsiVote = 1;  // Oversold → buy
            else if (currentRSI >= 70) rsiVote = -1; // Overbought → sell
        } else {
            // VOLATILE: momentum
            if (currentRSI > 60) rsiVote = 1;
            else if (currentRSI < 40) rsiVote = -1;
        }
        votes.push(rsiVote);
        voteDetails.rsi = {
            vote: rsiVote,
            reason: `RSI=${currentRSI?.toFixed(1)} (${regime})`,
            value: currentRSI
        };

        // 4. VWAP vote
        let vwapVote = 0;
        if (regime === REGIME.TRENDING_UP || regime === REGIME.TRENDING_DOWN) {
            // Trend: use VWAP as support/resistance
            vwapVote = priceAboveVWAP ? 1 : -1;
        } else {
            // Range: mean reversion
            if (currentVWAP !== null && vwapLower1 !== null && currentPrice <= vwapLower1) {
                vwapVote = 1; // At lower band → buy
            } else if (currentVWAP !== null && vwapUpper1 !== null && currentPrice >= vwapUpper1) {
                vwapVote = -1; // At upper band → sell
            }
        }
        votes.push(vwapVote);
        voteDetails.vwap = {
            vote: vwapVote,
            reason: vwapVote === 1 ? 'Above VWAP / At lower band' : vwapVote === -1 ? 'Below VWAP / At upper band' : 'Near VWAP',
            value: currentVWAP
        };

        // 5. ADX vote — confirms direction via DI
        let adxVote = 0;
        if (currentADX !== null && currentADX > 20) {
            // ADX strong enough to confirm trend
            if (plusDI > minusDI) adxVote = 1;
            else if (minusDI > plusDI) adxVote = -1;
        }
        votes.push(adxVote);
        voteDetails.adx = {
            vote: adxVote,
            reason: currentADX !== null ? `ADX=${currentADX.toFixed(1)}, +DI=${plusDI?.toFixed(1)}, -DI=${minusDI?.toFixed(1)}` : 'No data',
            value: currentADX
        };

        // 6. Volume vote
        let volVote = 0;
        if (volumeSpike) {
            volVote = isBullishCandle ? 1 : isBearishCandle ? -1 : 0;
        } else if (volumeRatio !== null && volumeRatio >= 0.8) {
            // Normal volume, use candle direction as weak signal
            volVote = isBullishCandle ? 1 : isBearishCandle ? -1 : 0;
        }
        votes.push(volVote);
        voteDetails.volume = {
            vote: volVote,
            reason: volumeSpike ? `Spike (${volumeRatio?.toFixed(2)}x)` : `Normal (${volumeRatio?.toFixed(2)}x)`,
            spike: volumeSpike,
            ratio: volumeRatio
        };

        // ---- Calculate Confluence ----
        const bullishVotes = votes.filter(v => v === 1).length;
        const bearishVotes = votes.filter(v => v === -1).length;
        const totalVotes = votes.length;

        // Direction: majority rules
        let direction = 'neutral';
        let agreeingCount = 0;
        if (bullishVotes > bearishVotes) {
            direction = 'bullish';
            agreeingCount = bullishVotes;
        } else if (bearishVotes > bullishVotes) {
            direction = 'bearish';
            agreeingCount = bearishVotes;
        }

        // Confluence confidence: how many agree / total
        const confluenceConfidence = Math.round((agreeingCount / totalVotes) * 100);

        return {
            direction,
            agreeingCount,
            totalVotes,
            bullishVotes,
            bearishVotes,
            confluenceConfidence,
            votes,
            voteDetails,
            indicators: {
                supertrend: { direction: stDirection, flipped: stFlipped, atr: stATR },
                ema: { value: currentEMA, above: priceAboveEMA, slopeUp: emaSlopeUp },
                rsi: { value: currentRSI, prev: prevRSI },
                vwap: { value: currentVWAP, upper1: vwapUpper1, lower1: vwapLower1, above: priceAboveVWAP },
                adx: { value: currentADX, plusDI, minusDI },
                volume: { ratio: volumeRatio, spike: volumeSpike, bullishCandle: isBullishCandle }
            },
            currentPrice
        };
    }

    emptyResult() {
        return {
            direction: 'neutral',
            agreeingCount: 0,
            totalVotes: 6,
            bullishVotes: 0,
            bearishVotes: 0,
            confluenceConfidence: 0,
            votes: [0, 0, 0, 0, 0, 0],
            voteDetails: {},
            indicators: {},
            currentPrice: null
        };
    }
}


// ============================================================
// SAFETY GUARDS
// ============================================================

class AISafetyGuards {
    constructor() {
        this.lastSignalTime = 0;
        this.internalCooldownMs = 30000; // 30 seconds for scalping
    }

    /**
     * Run all safety checks
     * @returns {object} - { allowed, reasons[] }
     */
    check(context, config) {
        const reasons = [];
        let allowed = true;

        // 1. Session filter
        if (config.sessionFilter && context?.session) {
            if (context.session.isDeadHours) {
                allowed = false;
                reasons.push('Dead hours (12AM-4AM PKT) — low volume');
            }
        }

        // 2. Funding squeeze filter
        if (config.fundingFilter && context?.funding) {
            if (context.funding.isExtreme) {
                allowed = false;
                reasons.push(`Extreme funding (${context.funding.ratePct}%) — squeeze risk`);
            }
        }

        // 3. Liquidation cascade protection (via OI + vol combo)
        if (config.liquidationFilter && context?.oi && context?.microVol) {
            if (context.oi.isSurging && context.microVol.level === 'EXTREME') {
                allowed = false;
                reasons.push('Liquidation cascade risk — OI surging + extreme volatility');
            }
        }

        // 4. Internal cooldown
        const elapsed = Date.now() - this.lastSignalTime;
        if (elapsed < this.internalCooldownMs && this.lastSignalTime > 0) {
            allowed = false;
            reasons.push(`Cooldown active (${Math.ceil((this.internalCooldownMs - elapsed) / 1000)}s remaining)`);
        }

        // 5. Dead volatility (tied to session filter — both are about market activity)
        if (config.sessionFilter && context?.microVol && context.microVol.level === 'DEAD') {
            allowed = false;
            reasons.push('Market is dead — no volatility for scalping');
        }

        return { allowed, reasons };
    }

    /**
     * Record that a signal was fired
     */
    recordSignal() {
        this.lastSignalTime = Date.now();
    }

    /**
     * Reset state
     */
    reset() {
        this.lastSignalTime = 0;
    }
}


// ============================================================
// MAIN AI SIGNAL FUNCTION
// ============================================================

// Singleton instances
const marketContext = new AIMarketContext();
const regimeDetector = new AIRegimeDetector();
const confluenceEngine = new AIConfluenceEngine();
const safetyGuards = new AISafetyGuards();

/**
 * Get AI signal — the main exported function
 * @param {Array} ohlcv - OHLCV data array
 * @param {object} config - AI indicator config
 * @param {boolean} skipContextFetch - If true, use cached context (for backtesting)
 * @returns {object} - Signal data matching standard interface
 */
async function getAISignalAsync(ohlcv, config = {}) {
    // Merge with defaults
    const cfg = {
        minConfluence: 4,
        minConfidence: 60,
        sessionFilter: true,
        fundingFilter: true,
        liquidationFilter: true,
        aggressiveness: 'balanced',
        contextRefreshInterval: 30000,
        ...config
    };

    // Adjust thresholds based on aggressiveness
    let minConf, minConfidence;
    switch (cfg.aggressiveness) {
        case 'conservative':
            minConf = 5;
            minConfidence = 70;
            break;
        case 'aggressive':
            minConf = 3;
            minConfidence = 50;
            break;
        case 'balanced':
        default:
            minConf = cfg.minConfluence;
            minConfidence = cfg.minConfidence;
            break;
    }

    // Configure market context
    marketContext.configure(cfg);

    // Fetch market context (async — this is the key difference from other indicators)
    const symbol = cfg.symbol || 'BTCUSDT';
    let context;
    try {
        context = await marketContext.fetchAll(symbol);
    } catch (err) {
        console.warn('[AI] Context fetch failed, using cache:', err.message);
        context = marketContext.getCachedContext();
    }

    // Detect market regime
    const regimeResult = regimeDetector.detect(ohlcv, context);

    // Run confluence engine
    const confluence = confluenceEngine.analyze(ohlcv, regimeResult.regime, context);

    // Safety checks
    const safety = safetyGuards.check(context, cfg);

    // ---- Generate final signal ----
    const reasoning = [];
    let primaryLong = false;
    let primaryShort = false;
    let secondaryLong = false;
    let secondaryShort = false;
    let protectionCloseLong = false;
    let protectionCloseShort = false;
    let confidence = 0;

    // Calculate overall confidence
    const regimeConfidence = regimeResult.confidence;
    const confluenceConfidence = confluence.confluenceConfidence;
    const contextBonus = (context?.scalpScore || 50) > 60 ? 10 : 0;
    confidence = Math.round((regimeConfidence * 0.3 + confluenceConfidence * 0.6) + contextBonus);
    confidence = Math.max(0, Math.min(100, confidence));

    reasoning.push(`Regime: ${regimeResult.regime} (${regimeResult.confidence}%)`);
    reasoning.push(`Confluence: ${confluence.agreeingCount}/${confluence.totalVotes} ${confluence.direction}`);

    if (context?.scalpScore !== undefined) {
        reasoning.push(`Scalp Score: ${context.scalpScore}/100`);
    }

    // Primary signals — require confluence + confidence + safety
    if (safety.allowed && confluence.agreeingCount >= minConf && confidence >= minConfidence) {
        if (confluence.direction === 'bullish') {
            primaryLong = true;
            reasoning.push(`✅ LONG signal — ${confluence.agreeingCount}/${confluence.totalVotes} bullish confluence`);
            safetyGuards.recordSignal();
        } else if (confluence.direction === 'bearish') {
            primaryShort = true;
            reasoning.push(`✅ SHORT signal — ${confluence.agreeingCount}/${confluence.totalVotes} bearish confluence`);
            safetyGuards.recordSignal();
        }
    } else if (!safety.allowed) {
        reasoning.push(`⛔ Signal blocked: ${safety.reasons.join(', ')}`);
    } else if (confluence.agreeingCount < minConf) {
        reasoning.push(`⚠️ Low confluence: ${confluence.agreeingCount}/${minConf} required`);
    } else if (confidence < minConfidence) {
        reasoning.push(`⚠️ Low confidence: ${confidence}% < ${minConfidence}% required`);
    }

    // Secondary signals — looser requirements
    if (confluence.direction === 'bullish' && confluence.agreeingCount >= 3) {
        secondaryLong = true;
    } else if (confluence.direction === 'bearish' && confluence.agreeingCount >= 3) {
        secondaryShort = true;
    }

    // Position protection
    // Close long if regime flips bearish and confluence is bearish
    if (regimeResult.regime === REGIME.TRENDING_DOWN && confluence.direction === 'bearish' && confluence.agreeingCount >= 4) {
        protectionCloseLong = true;
        reasoning.push('🛡️ Close LONG — regime + confluence turned bearish');
    }
    // Close short if regime flips bullish
    if (regimeResult.regime === REGIME.TRENDING_UP && confluence.direction === 'bullish' && confluence.agreeingCount >= 4) {
        protectionCloseShort = true;
        reasoning.push('🛡️ Close SHORT — regime + confluence turned bullish');
    }
    // Extreme vol protection — close any position
    if (regimeResult.regime === REGIME.VOLATILE && context?.microVol?.level === 'EXTREME') {
        protectionCloseLong = true;
        protectionCloseShort = true;
        reasoning.push('🛡️ Close ALL — extreme volatile regime');
    }

    // Calculate suggested SL/TP based on ATR
    const atr = confluence.indicators?.supertrend?.atr;
    let suggestedSL = null;
    let suggestedTP = null;
    if (atr && confluence.currentPrice) {
        const slMultiplier = regimeResult.regime === REGIME.VOLATILE ? 2.0 : 1.2;
        const tpMultiplier = regimeResult.regime === REGIME.TRENDING_UP || regimeResult.regime === REGIME.TRENDING_DOWN ? 2.5 : 1.5;
        suggestedSL = atr * slMultiplier;
        suggestedTP = atr * tpMultiplier;
    }

    return {
        // Standard indicator interface
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        protectionCloseLong,
        protectionCloseShort,

        // AI-specific metadata
        regime: regimeResult.regime,
        regimeConfidence: regimeResult.confidence,
        regimeDetails: regimeResult.details,
        confidence,
        confluenceScore: {
            agreeing: confluence.agreeingCount,
            total: confluence.totalVotes,
            bullish: confluence.bullishVotes,
            bearish: confluence.bearishVotes,
            direction: confluence.direction
        },
        voteDetails: confluence.voteDetails,
        marketContext: {
            funding: context?.funding ? {
                rate: context.funding.ratePct,
                direction: context.funding.direction,
                isExtreme: context.funding.isExtreme
            } : null,
            oi: context?.oi ? {
                change: context.oi.change,
                direction: context.oi.direction,
                isSurging: context.oi.isSurging
            } : null,
            ls: context?.ls ? {
                ratio: context.ls.ratio,
                squeezeRisk: context.ls.squeezeRisk
            } : null,
            microVol: context?.microVol ? {
                score: context.microVol.score,
                level: context.microVol.level,
                volumeSpike: context.microVol.volumeSpike
            } : null,
            session: context?.session || null,
            scalpScore: context?.scalpScore || 0
        },
        reasoning,
        safetyStatus: safety,

        // Scalping-specific
        suggestedStopDistance: suggestedSL,
        suggestedTPDistance: suggestedTP,
        currentATR: atr,
        currentPrice: confluence.currentPrice
    };
}


/**
 * Synchronous wrapper for signal engine compatibility
 * Uses cached context (non-blocking)
 * @param {Array} ohlcv - OHLCV data
 * @param {object} config - AI config
 * @returns {object} - Signal data
 */
function getAISignal(ohlcv, config = {}) {
    const cfg = {
        minConfluence: 4,
        minConfidence: 60,
        sessionFilter: true,
        fundingFilter: true,
        liquidationFilter: true,
        aggressiveness: 'balanced',
        ...config
    };

    const isBacktest = cfg.backtestMode === true;

    // Adjust thresholds based on aggressiveness
    let minConf, minConfidence;
    switch (cfg.aggressiveness) {
        case 'conservative':
            minConf = 5;
            minConfidence = 70;
            break;
        case 'aggressive':
            minConf = 3;
            minConfidence = 50;
            break;
        default:
            minConf = cfg.minConfluence;
            minConfidence = cfg.minConfidence;
            break;
    }

    // Use cached context (synchronous — no API calls)
    // In backtest mode, use neutral empty context to avoid live-data dependency
    const context = isBacktest ? { scalpScore: 50 } : marketContext.getCachedContext();

    // Detect regime
    const regimeResult = regimeDetector.detect(ohlcv, context);

    // Run confluence
    const confluence = confluenceEngine.analyze(ohlcv, regimeResult.regime, context);

    // Safety checks — SKIP in backtest mode (cooldown uses Date.now(), filters need live API data)
    const safety = isBacktest
        ? { allowed: true, reasons: [] }
        : safetyGuards.check(context, cfg);

    // Generate signal
    const reasoning = [];
    let primaryLong = false;
    let primaryShort = false;
    let secondaryLong = false;
    let secondaryShort = false;
    let protectionCloseLong = false;
    let protectionCloseShort = false;

    const regimeConfidence = regimeResult.confidence;
    const confluenceConfidence = confluence.confluenceConfidence;
    const contextBonus = (context?.scalpScore || 50) > 60 ? 10 : 0;
    let confidence = Math.round((regimeConfidence * 0.3 + confluenceConfidence * 0.6) + contextBonus);
    confidence = Math.max(0, Math.min(100, confidence));

    reasoning.push(`Regime: ${regimeResult.regime} (${regimeResult.confidence}%)`);
    reasoning.push(`Confluence: ${confluence.agreeingCount}/${confluence.totalVotes} ${confluence.direction}`);

    if (safety.allowed && confluence.agreeingCount >= minConf && confidence >= minConfidence) {
        if (confluence.direction === 'bullish') {
            primaryLong = true;
            reasoning.push(`✅ LONG — ${confluence.agreeingCount}/${confluence.totalVotes} confluence`);
            if (!isBacktest) safetyGuards.recordSignal();
        } else if (confluence.direction === 'bearish') {
            primaryShort = true;
            reasoning.push(`✅ SHORT — ${confluence.agreeingCount}/${confluence.totalVotes} confluence`);
            if (!isBacktest) safetyGuards.recordSignal();
        }
    } else if (!safety.allowed) {
        reasoning.push(`⛔ Blocked: ${safety.reasons.join(', ')}`);
    } else {
        reasoning.push(`⚠️ No signal: confluence=${confluence.agreeingCount}/${minConf}, confidence=${confidence}%/${minConfidence}%`);
    }

    if (confluence.direction === 'bullish' && confluence.agreeingCount >= 3) secondaryLong = true;
    if (confluence.direction === 'bearish' && confluence.agreeingCount >= 3) secondaryShort = true;

    if (regimeResult.regime === REGIME.TRENDING_DOWN && confluence.direction === 'bearish' && confluence.agreeingCount >= 4) {
        protectionCloseLong = true;
    }
    if (regimeResult.regime === REGIME.TRENDING_UP && confluence.direction === 'bullish' && confluence.agreeingCount >= 4) {
        protectionCloseShort = true;
    }
    if (regimeResult.regime === REGIME.VOLATILE && context?.microVol?.level === 'EXTREME') {
        protectionCloseLong = true;
        protectionCloseShort = true;
    }

    const atr = confluence.indicators?.supertrend?.atr;

    return {
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        protectionCloseLong,
        protectionCloseShort,
        regime: regimeResult.regime,
        regimeConfidence: regimeResult.confidence,
        regimeDetails: regimeResult.details,
        confidence,
        confluenceScore: {
            agreeing: confluence.agreeingCount,
            total: confluence.totalVotes,
            bullish: confluence.bullishVotes,
            bearish: confluence.bearishVotes,
            direction: confluence.direction
        },
        voteDetails: confluence.voteDetails,
        marketContext: {
            funding: context?.funding ? { rate: context.funding.ratePct, direction: context.funding.direction, isExtreme: context.funding.isExtreme } : null,
            oi: context?.oi ? { change: context.oi.change, direction: context.oi.direction, isSurging: context.oi.isSurging } : null,
            ls: context?.ls ? { ratio: context.ls.ratio, squeezeRisk: context.ls.squeezeRisk } : null,
            microVol: context?.microVol ? { score: context.microVol.score, level: context.microVol.level, volumeSpike: context.microVol.volumeSpike } : null,
            session: context?.session || null,
            scalpScore: context?.scalpScore || 0
        },
        reasoning,
        safetyStatus: safety,
        suggestedStopDistance: atr ? atr * 1.2 : null,
        suggestedTPDistance: atr ? atr * 2.0 : null,
        currentATR: atr,
        currentPrice: confluence.currentPrice
    };
}

/**
 * Trigger async market context refresh
 * Called by service worker on each tick
 */
async function refreshAIContext(symbol = 'BTCUSDT') {
    return marketContext.fetchAll(symbol);
}

/**
 * Reset AI state (for backtesting)
 */
function resetAI() {
    marketContext.reset();
    safetyGuards.reset();
}

// Export
export {
    getAISignal,
    getAISignalAsync,
    refreshAIContext,
    resetAI,
    AIMarketContext,
    AIRegimeDetector,
    AIConfluenceEngine,
    AISafetyGuards,
    REGIME,
    SCALP_PARAMS
};
