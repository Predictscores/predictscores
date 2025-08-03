// components/TradingViewChart.js

import React, { useEffect, useRef } from 'react';

const TradingViewChart = ({ symbol = "BTCUSDT", theme = "dark", height = 200 }) => {
  const containerRef = useRef();

  useEffect(() => {
    // Clean up previous widget if re-rendered
    if (containerRef.current) {
      containerRef.current.innerHTML = '';
    }
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
      if (window.TradingView) {
        new window.TradingView.widget({
          autosize: true,
          symbol: `BINANCE:${symbol}`,
          interval: '15',
          timezone: 'Europe/Belgrade',
          theme: theme,
          style: "1", // 1 = candlestick
          locale: "en",
          toolbar_bg: "#222",
          enable_publishing: false,
          hide_top_toolbar: true,
          hide_legend: true,
          save_image: false,
          container_id: containerRef.current.id,
          height,
        });
      }
    };
    containerRef.current.appendChild(script);
    // Cleanup function
    return () => {
      if (containerRef.current) containerRef.current.innerHTML = '';
    };
  }, [symbol, theme, height]);

  return (
    <div
      id={`tv_chart_${symbol}_${theme}`}
      ref={containerRef}
      style={{ width: "100%", height: height, borderRadius: 12, overflow: "hidden", background: theme === "dark" ? "#222" : "#fff" }}
    ></div>
  );
};

export default TradingViewChart;
