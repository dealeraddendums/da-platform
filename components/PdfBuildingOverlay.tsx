"use client";

interface Props {
  visible: boolean;
}

export default function PdfBuildingOverlay({ visible }: Props) {
  if (!visible) return null;

  return (
    <div style={{
      position: "fixed", inset: 0, zIndex: 9999,
      background: "#2a2b3c",
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
      fontFamily: "Roboto, -apple-system, sans-serif",
    }}>
      {/* SVG car assembly animation */}
      <svg width="400" height="180" viewBox="0 0 400 180" fill="none" xmlns="http://www.w3.org/2000/svg">
        <style>{`
          @keyframes chassisSlide {
            0%   { transform: translateX(-120px); opacity: 0; }
            15%  { transform: translateX(0);      opacity: 1; }
            80%  { transform: translateX(0);      opacity: 1; }
            100% { transform: translateX(160px);  opacity: 0; }
          }
          @keyframes bodyDrop {
            0%   { transform: translateY(-60px);  opacity: 0; }
            15%  { transform: translateY(-60px);  opacity: 0; }
            28%  { transform: translateY(0);      opacity: 1; }
            80%  { transform: translateY(0);      opacity: 1; }
            100% { transform: translateY(0);      opacity: 0; }
          }
          @keyframes wheelLeft {
            0%   { transform: translateX(-80px);  opacity: 0; }
            28%  { transform: translateX(-80px);  opacity: 0; }
            42%  { transform: translateX(0);      opacity: 1; }
            80%  { transform: translateX(0);      opacity: 1; }
            100% { transform: translateX(160px);  opacity: 0; }
          }
          @keyframes wheelRight {
            0%   { transform: translateX(80px);   opacity: 0; }
            28%  { transform: translateX(80px);   opacity: 0; }
            42%  { transform: translateX(0);      opacity: 1; }
            80%  { transform: translateX(0);      opacity: 1; }
            100% { transform: translateX(160px);  opacity: 0; }
          }
          @keyframes windowsFade {
            0%   { opacity: 0; }
            42%  { opacity: 0; }
            55%  { opacity: 1; }
            80%  { opacity: 1; }
            100% { opacity: 0; }
          }
          @keyframes lightsFlash {
            0%   { opacity: 0; }
            55%  { opacity: 0; }
            62%  { opacity: 1; }
            67%  { opacity: 0.3; }
            72%  { opacity: 1; }
            80%  { opacity: 1; }
            100% { opacity: 0; }
          }
          @keyframes driveOff {
            0%   { transform: translateX(0); }
            80%  { transform: translateX(0); }
            100% { transform: translateX(160px); }
          }
          .car-group {
            animation: driveOff 2.5s ease-in-out infinite;
            transform-origin: center;
          }
          .chassis   { animation: chassisSlide 2.5s ease-out infinite; }
          .body      { animation: bodyDrop    2.5s ease-out infinite; }
          .wheel-l   { animation: wheelLeft   2.5s ease-out infinite; }
          .wheel-r   { animation: wheelRight  2.5s ease-out infinite; }
          .windows   { animation: windowsFade 2.5s ease-in  infinite; }
          .lights    { animation: lightsFlash 2.5s linear   infinite; }
        `}</style>

        <g className="car-group">
          {/* Chassis — flat platform */}
          <g className="chassis">
            <rect x="80" y="110" width="240" height="18" rx="4" fill="#ffa500" />
            {/* Wheel wells */}
            <rect x="93"  y="108" width="44" height="12" rx="6" fill="#1e1f2e" />
            <rect x="263" y="108" width="44" height="12" rx="6" fill="#1e1f2e" />
          </g>

          {/* Body */}
          <g className="body">
            {/* Main body */}
            <rect x="88" y="72" width="224" height="42" rx="6" fill="#3d5a80" />
            {/* Roof cab */}
            <path d="M130 72 L155 38 L245 38 L270 72 Z" fill="#3d5a80" />
            {/* Body accent stripe */}
            <rect x="88" y="106" width="224" height="6" rx="0" fill="#2e4a6e" />
          </g>

          {/* Windows */}
          <g className="windows">
            {/* Windshield */}
            <path d="M158 70 L168 44 L228 44 L238 70 Z" fill="#8ecae6" opacity="0.85" />
            {/* Side windows */}
            <rect x="93"  y="76" width="52" height="28" rx="3" fill="#8ecae6" opacity="0.75" />
            <rect x="255" y="76" width="52" height="28" rx="3" fill="#8ecae6" opacity="0.75" />
          </g>

          {/* Headlights */}
          <g className="lights">
            <rect x="88"  y="80" width="18" height="10" rx="3" fill="#ffa500" />
            <ellipse cx="97" cy="85" rx="6" ry="4" fill="#fff" opacity="0.6" />
          </g>

          {/* Left wheel */}
          <g className="wheel-l">
            <circle cx="117" cy="128" r="22" fill="#1e1f2e" />
            <circle cx="117" cy="128" r="14" fill="#444" />
            <circle cx="117" cy="128" r="6"  fill="#666" />
            {/* Spokes */}
            <line x1="117" y1="114" x2="117" y2="122" stroke="#888" strokeWidth="2" />
            <line x1="117" y1="134" x2="117" y2="142" stroke="#888" strokeWidth="2" />
            <line x1="103" y1="128" x2="111" y2="128" stroke="#888" strokeWidth="2" />
            <line x1="123" y1="128" x2="131" y2="128" stroke="#888" strokeWidth="2" />
          </g>

          {/* Right wheel */}
          <g className="wheel-r">
            <circle cx="283" cy="128" r="22" fill="#1e1f2e" />
            <circle cx="283" cy="128" r="14" fill="#444" />
            <circle cx="283" cy="128" r="6"  fill="#666" />
            <line x1="283" y1="114" x2="283" y2="122" stroke="#888" strokeWidth="2" />
            <line x1="283" y1="134" x2="283" y2="142" stroke="#888" strokeWidth="2" />
            <line x1="269" y1="128" x2="277" y2="128" stroke="#888" strokeWidth="2" />
            <line x1="289" y1="128" x2="297" y2="128" stroke="#888" strokeWidth="2" />
          </g>
        </g>

        {/* Ground line */}
        <line x1="20" y1="150" x2="380" y2="150" stroke="rgba(255,255,255,0.15)" strokeWidth="1" />
      </svg>

      <p style={{ color: "#ffffff", fontSize: 18, fontWeight: 500, marginTop: 24, letterSpacing: "0.01em" }}>
        Building your addenda…
      </p>
      <p style={{ color: "#ffa500", fontSize: 13, marginTop: 8, opacity: 0.85 }}>
        Please wait, this may take a moment
      </p>
    </div>
  );
}
