import React, { useEffect } from 'react';

interface SaveConfirmationProps {
  isOpen: boolean;
  onClose: () => void;
  personName: string;
}

const SaveConfirmation: React.FC<SaveConfirmationProps> = ({ isOpen, onClose, personName }) => {
  useEffect(() => {
    if (isOpen) {
      const timer = setTimeout(() => {
        onClose();
      }, 2500);
      return () => clearTimeout(timer);
    }
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-70 flex items-center justify-center p-4 animate-fade-in">
      <div 
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
        onClick={onClose}
      ></div>
      
      <div className="relative bg-gradient-to-br from-gray-900 to-gray-800 border-2 border-cyan-500/50 rounded-2xl p-6 sm:p-8 max-w-md w-full shadow-2xl shadow-cyan-500/30 animate-slide-up-fade">
        <div className="text-center">
          <div className="mx-auto w-16 h-16 sm:w-20 sm:h-20 rounded-full bg-gradient-to-br from-cyan-500 to-green-500 flex items-center justify-center mb-4 animate-scale-in shadow-lg shadow-cyan-500/50">
            <svg 
              className="w-8 h-8 sm:w-10 sm:h-10 text-white animate-checkmark" 
              fill="none" 
              stroke="currentColor" 
              viewBox="0 0 24 24"
            >
              <path 
                strokeLinecap="round" 
                strokeLinejoin="round" 
                strokeWidth={3} 
                d="M5 13l4 4L19 7"
              />
            </svg>
          </div>
          
          <h2 className="font-exo text-xl sm:text-2xl font-bold text-white mb-2 animate-slide-up-fade" style={{animationDelay: '100ms'}}>
            Dossier Saved Successfully!
          </h2>
          
          <p className="text-cyan-300 text-sm sm:text-base animate-slide-up-fade" style={{animationDelay: '200ms'}}>
            Intelligence report for <span className="font-bold text-white">{personName}</span> has been saved to your database.
          </p>
          
          <button
            onClick={onClose}
            className="mt-6 px-6 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-full transition-colors duration-300 text-sm font-semibold shadow-lg shadow-cyan-500/30 hover:shadow-cyan-500/50 animate-slide-up-fade"
            style={{animationDelay: '300ms'}}
          >
            Close
          </button>
        </div>
      </div>
      
      <style>{`
        @keyframes checkmark {
          0% {
            stroke-dasharray: 0 50;
            stroke-dashoffset: 0;
          }
          100% {
            stroke-dasharray: 50 50;
            stroke-dashoffset: 0;
          }
        }
        
        @keyframes scale-in {
          0% {
            transform: scale(0);
            opacity: 0;
          }
          50% {
            transform: scale(1.1);
          }
          100% {
            transform: scale(1);
            opacity: 1;
          }
        }
        
        .animate-checkmark path {
          stroke-dasharray: 50;
          stroke-dashoffset: 50;
          animation: checkmark 0.5s ease-in-out 0.3s forwards;
        }
        
        .animate-scale-in {
          animation: scale-in 0.5s ease-out forwards;
        }
      `}</style>
    </div>
  );
};

export default SaveConfirmation;
