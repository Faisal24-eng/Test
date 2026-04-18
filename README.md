# Nexus Trading Terminal (Web App)

A high-performance crypto trading dashboard and automation engine. Ported from the Nexus Browser Extension, this web application provides advanced indicators, real-time market monitoring, and an autonomous parameter optimizer.

## Features

- **🚀 Live Price Bar**: Real-time price monitoring with flash animations for multiple markets.
- **🤖 AI Confluence Engine**: Meta-indicator that aggregates signals from 6+ technical indicators with regime detection.
- **⚡ AI Optimizer (Hyper-Run)**: In-browser grid search for calculating optimal trading parameters using historical data.
- **📊 Technical indicators**: Supertrend, RSI, EMA, VWAP, Order Book Imbalance, and more.
- **🔄 WebSocket Status Monitor**: Real-time health tracking of Binance API connections.

## Project Structure

- `index.html`: Main UI structure and layouts.
- `app.js`: UI Controller and state synchronization.
- `background-engine.js`: Core market monitoring and signal calculation loop.
- `lib/`: Modularized trading logic and indicator scripts.
- `assets/`: Icons and static resources.

## Deployment

1. Clone the repository.
2. Open `index.html` in any modern web browser.
3. Configure your desired markets in the **Data Center**.
4. Activate the **AI Bot** or individual indicators in the **Indicators** tab.

## License

Copyright © 2026. All rights reserved.
