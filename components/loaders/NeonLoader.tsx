import React from 'react';

interface NeonLoaderProps {
  size?: 'sm' | 'md' | 'lg';
  text?: string;
}

export const NeonLoader: React.FC<NeonLoaderProps> = ({ size = 'md', text }) => {
  const sizeClasses = {
    sm: 'w-12 h-12',
    md: 'w-20 h-20',
    lg: 'w-32 h-32'
  };

  return (
    <div className="flex flex-col items-center justify-center gap-4">
      <div className={`${sizeClasses[size]} relative`}>
        <div className="absolute inset-0 rounded-full border-4 border-cyan-500/20"></div>
        <div className="absolute inset-0 rounded-full border-4 border-transparent border-t-cyan-400 animate-spin neon-glow"></div>
        <div className="absolute inset-2 rounded-full border-4 border-transparent border-t-blue-400 animate-spin-slow neon-glow" style={{animationDirection: 'reverse'}}></div>
        <div className="absolute inset-4 rounded-full border-2 border-transparent border-t-cyan-300 animate-spin-fast neon-glow"></div>
      </div>
      {text && (
        <p className="text-cyan-300 text-sm font-exo animate-pulse">{text}</p>
      )}
    </div>
  );
};

export const DataStreamLoader: React.FC<{ text?: string }> = ({ text = 'Processing...' }) => {
  return (
    <div className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="relative w-64 h-32">
        {[...Array(8)].map((_, i) => (
          <div
            key={i}
            className="absolute left-0 right-0 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent opacity-50"
            style={{
              top: `${i * 16}px`,
              animation: `scan-line ${2 + i * 0.1}s ease-in-out infinite`,
              animationDelay: `${i * 0.15}s`
            }}
          />
        ))}
      </div>
      <div className="text-center">
        <p className="text-cyan-300 text-lg font-exo mb-2">{text}</p>
        <div className="flex gap-1 justify-center">
          {[...Array(3)].map((_, i) => (
            <div
              key={i}
              className="w-2 h-2 rounded-full bg-cyan-400 animate-bounce neon-glow"
              style={{animationDelay: `${i * 0.2}s`}}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

export const ProfileBuildingLoader: React.FC = () => {
  const steps = [
    'Scanning digital footprint',
    'Analyzing professional data',
    'Gathering recent activities',
    'Building intelligence profile'
  ];

  return (
    <div className="w-full max-w-md mx-auto p-6 space-y-6">
      <div className="relative h-2 bg-gray-800 rounded-full overflow-hidden">
        <div className="absolute inset-0 bg-gradient-to-r from-cyan-500 via-blue-500 to-cyan-500 animate-shimmer neon-glow"></div>
      </div>
      
      <div className="space-y-3">
        {steps.map((step, i) => (
          <div
            key={i}
            className="flex items-center gap-3 opacity-0 animate-fade-in"
            style={{animationDelay: `${i * 0.5}s`, animationFillMode: 'forwards'}}
          >
            <div className="w-3 h-3 rounded-full bg-cyan-400 animate-pulse neon-glow"></div>
            <span className="text-cyan-300 text-sm font-exo">{step}</span>
            <div className="flex-1 h-px bg-gradient-to-r from-cyan-500/50 to-transparent"></div>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-4 gap-2 mt-8">
        {[...Array(16)].map((_, i) => (
          <div
            key={i}
            className="h-1 bg-cyan-500/20 rounded animate-pulse neon-glow"
            style={{
              animationDelay: `${i * 0.1}s`,
              animationDuration: `${1 + Math.random()}s`
            }}
          />
        ))}
      </div>
    </div>
  );
};

export const ScanningLoader: React.FC<{ target?: string }> = ({ target = 'operative' }) => {
  return (
    <div className="flex flex-col items-center justify-center gap-6 p-8">
      <div className="relative w-48 h-48">
        <div className="absolute inset-0 border-2 border-cyan-500/30 rounded-full"></div>
        <div className="absolute inset-0 border-2 border-cyan-400 rounded-full animate-ping"></div>
        <div className="absolute inset-8 border-2 border-blue-400 rounded-full animate-pulse"></div>
        
        <div className="absolute inset-0 flex items-center justify-center">
          <div className="w-24 h-24 rounded-full bg-gradient-to-br from-cyan-500/20 to-blue-500/20 backdrop-blur-sm border border-cyan-400/50 flex items-center justify-center">
            <svg className="w-12 h-12 text-cyan-400 animate-pulse" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 7a4 4 0 11-8 0 4 4 0 018 0zM12 14a7 7 0 00-7 7h14a7 7 0 00-7-7z" />
            </svg>
          </div>
        </div>

        <div className="absolute inset-0 animate-spin-slow" style={{animationDuration: '8s'}}>
          <div className="absolute top-0 left-1/2 w-1 h-24 bg-gradient-to-b from-cyan-400 to-transparent -translate-x-1/2"></div>
        </div>
      </div>

      <div className="text-center">
        <p className="text-cyan-300 text-lg font-exo mb-2">Scanning {target}...</p>
        <div className="flex gap-1 justify-center">
          <div className="w-16 h-1 bg-gradient-to-r from-transparent via-cyan-400 to-transparent animate-scan"></div>
        </div>
      </div>
    </div>
  );
};
