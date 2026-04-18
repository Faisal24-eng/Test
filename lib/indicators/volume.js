// ================================================
// NEXUS TRADING TERMINAL - VOLUME INDICATOR
// With MA comparison
// ================================================

import { calculateEMA } from './ema.js';

/**
 * Calculate Volume MA and analysis
 * @param {Array} ohlcv - OHLCV data array
 * @param {number} maLength - MA length for volume
 * @returns {object}
 */
function calculateVolumeAnalysis(ohlcv, maLength = 20) {
    if (!ohlcv || ohlcv.length < maLength) {
        return {
            volumes: [],
            volumeMA: [],
            volumeRatio: []
        };
    }

    const volumes = ohlcv.map(c => c.volume);
    const volumeMA = calculateEMA(volumes, maLength);

    // Calculate volume ratio (current / MA)
    const volumeRatio = [];
    for (let i = 0; i < volumes.length; i++) {
        if (volumeMA[i] === null || volumeMA[i] === 0) {
            volumeRatio.push(null);
        } else {
            volumeRatio.push(volumes[i] / volumeMA[i]);
        }
    }

    return {
        volumes,
        volumeMA,
        volumeRatio
    };
}

/**
 * Get current Volume signal
 * @param {Array} ohlcv - OHLCV data
 * @param {number} maLength - Volume MA length
 * @param {number} confirmationMultiplier - Multiplier for confirmation (default 1.0)
 * @param {number} againstMultiplier - Multiplier for against volume (default 1.5)
 * @returns {object}
 */
function getVolumeSignal(ohlcv, maLength = 20, confirmationMultiplier = 1.0, againstMultiplier = 1.5) {
    const result = calculateVolumeAnalysis(ohlcv, maLength);

    if (result.volumeRatio.length === 0 || !ohlcv || ohlcv.length === 0) {
        return {
            volume: null,
            volumeMA: null,
            volumeRatio: null,
            isConfirmationVolume: false,
            isAgainstVolume: false,
            isBullishCandle: false,
            isBearishCandle: false,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: true,  // Default to true so it doesn't block
            secondaryShort: true,
            protectionCloseLong: false,
            protectionCloseShort: false
        };
    }

    const len = result.volumeRatio.length;
    const currentVolume = result.volumes[len - 1];
    const currentVolumeMA = result.volumeMA[len - 1];
    const currentRatio = result.volumeRatio[len - 1];

    if (currentRatio === null) {
        return {
            volume: currentVolume,
            volumeMA: currentVolumeMA,
            volumeRatio: null,
            isConfirmationVolume: false,
            isAgainstVolume: false,
            isBullishCandle: false,
            isBearishCandle: false,
            primaryLong: false,
            primaryShort: false,
            secondaryLong: true,
            secondaryShort: true,
            protectionCloseLong: false,
            protectionCloseShort: false
        };
    }

    const currentCandle = ohlcv[len - 1];
    const isBullishCandle = currentCandle.close > currentCandle.open;
    const isBearishCandle = currentCandle.close < currentCandle.open;

    // Volume thresholds
    const isConfirmationVolume = currentRatio >= confirmationMultiplier;
    const isAgainstVolume = currentRatio >= againstMultiplier;

    // Volume spike threshold for primary signals (1.5x MA by default)
    const isVolumeSpike = currentRatio >= 1.5;

    // Primary signals: Volume spike + candle direction
    const primaryLong = isBullishCandle && isVolumeSpike;
    const primaryShort = isBearishCandle && isVolumeSpike;

    // Secondary signals: Allow trade if confirmation volume is present
    // Using >= 0.8 to be more permissive (80% of average volume or more)
    const secondaryLong = currentRatio >= 0.8;
    const secondaryShort = currentRatio >= 0.8;

    // Position protection
    const protectionCloseLong = isBearishCandle && isAgainstVolume;
    const protectionCloseShort = isBullishCandle && isAgainstVolume;

    return {
        volume: currentVolume,
        volumeMA: currentVolumeMA,
        volumeRatio: currentRatio,
        isConfirmationVolume,
        isAgainstVolume,
        isVolumeSpike,
        isBullishCandle,
        isBearishCandle,
        primaryLong,
        primaryShort,
        secondaryLong,
        secondaryShort,
        protectionCloseLong,
        protectionCloseShort
    };
}

export { calculateVolumeAnalysis, getVolumeSignal };
