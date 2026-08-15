import React, { useState } from 'react';
import { ZohoIcon } from './icons/BrandIcons';
import { UserIcon, LockIcon } from './icons/UIIcons';

const LoginButton: React.FC<{ icon: React.ReactNode; label: string; href: string }> = ({ icon, label, href }) => {
  const handleClick = (e: React.MouseEvent) => {
    e.preventDefault();
    // Open in new window to avoid iframe restrictions
    const authWindow = window.open(href, '_blank', 'width=500,height=700,scrollbars=yes');
    
    // Listen for auth success message from popup
    const messageHandler = (event: MessageEvent) => {
      if (event.data?.type === 'auth_success') {
        window.removeEventListener('message', messageHandler);
        // Small delay to ensure session cookie is processed
        setTimeout(() => {
          window.location.reload();
        }, 300);
      }
    };
    window.addEventListener('message', messageHandler);
    
    // Fallback: Poll for window close if message isn't received
    const pollTimer = setInterval(() => {
      if (authWindow?.closed) {
        clearInterval(pollTimer);
        window.removeEventListener('message', messageHandler);
        window.location.reload();
      }
    }, 500);
  };

  return (
    <a
      href={href}
      onClick={handleClick}
      className="w-full flex items-center justify-center space-x-4 px-6 py-3 border border-cyan-400/30 bg-cyan-900/20 rounded-lg backdrop-blur-sm
                 hover:bg-cyan-700/40 hover:border-cyan-300 transition-all duration-300 group btn-glow cursor-pointer"
    >
      <span className="text-cyan-300 group-hover:text-white transition-colors">{icon}</span>
      <span className="font-exo text-base text-cyan-200 group-hover:text-white transition-colors">{label}</span>
    </a>
  );
};

const InputField: React.FC<{ icon: React.ReactNode, type: string, placeholder: string, value: string, onChange: (e: React.ChangeEvent<HTMLInputElement>) => void }> = 
({ icon, type, placeholder, value, onChange }) => (
    <div className="relative">
        <div className="absolute left-4 top-1/2 -translate-y-1/2 text-cyan-400 pointer-events-none">{icon}</div>
        <input 
            type={type}
            placeholder={placeholder}
            value={value}
            onChange={onChange}
            className="w-full pl-12 pr-4 py-3 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-cyan-400 focus:border-cyan-400 transition-all duration-300"
        />
    </div>
);

interface LoginScreenProps {
  onContinueAsGuest?: () => void;
}

const LoginScreen: React.FC<LoginScreenProps> = ({ onContinueAsGuest }) => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [view, setView] = useState<'login' | 'forgotPassword'>('login');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleEmailSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await fetch('/api/login/email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.message || 'Authentication failed. Please try again.');
        return;
      }
      window.location.reload();
    } catch {
      setError('Network error. Please try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const handleForgotPasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    alert('Password reset is not available yet. Please contact the administrator to reset your password.');
    setView('login');
  };

  return (
    <div className="flex items-center justify-center h-full relative p-4">
      <div 
        className="absolute inset-0 bg-cover bg-center opacity-20"
        style={{ backgroundImage: "url('/generated_images/Professional_meeting_intelligence_background_cd6dfd30.png')" }}
      />
      <div className="absolute inset-0 bg-gradient-to-b from-transparent via-black/40 to-black/60" />
      <div className="relative w-full max-w-md p-6 sm:p-8 space-y-4 sm:space-y-6 bg-black/40 rounded-2xl shadow-2xl shadow-cyan-500/10 border border-cyan-500/20 backdrop-blur-xl animate-slide-up-fade">
        {view === 'login' ? (
          <>
            <div className="text-center">
              <h2 className="font-exo text-2xl sm:text-3xl font-bold text-white">Access Terminal</h2>
              <p className="mt-2 text-sm sm:text-base text-cyan-300">Authenticate for full access</p>
            </div>
            <form className="space-y-3" onSubmit={handleEmailSubmit}>
              <InputField icon={<UserIcon />} type="email" placeholder="Email Address" value={email} onChange={(e) => setEmail(e.target.value)} />
              <InputField icon={<LockIcon />} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
              {error && <p className="text-sm text-red-400 text-center">{error}</p>}
              <button
                type="submit"
                disabled={submitting}
                className="w-full font-exo text-lg py-3 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg text-slate-900 font-bold transition-all duration-300 shadow-lg shadow-cyan-500/20 btn-glow"
              >
                {submitting ? 'Authenticating...' : 'Sign In'}
              </button>
              <div className="flex justify-end text-sm">
                <button type="button" onClick={() => setView('forgotPassword')} className="text-gray-400 hover:underline">
                  Forgot password?
                </button>
              </div>
            </form>

            <div className="space-y-2 sm:space-y-3">
              <LoginButton icon={<ZohoIcon />} label="Sign in with Zoho" href="/api/login/zoho" />
            </div>
            
            {onContinueAsGuest && (
              <>
                <div className="relative my-6">
                  <div className="absolute inset-0 flex items-center">
                    <div className="w-full border-t border-cyan-500/30"></div>
                  </div>
                  <div className="relative flex justify-center text-sm">
                    <span className="px-2 bg-black/30 text-gray-400">Or</span>
                  </div>
                </div>
                
                <button
                  onClick={onContinueAsGuest}
                  className="w-full px-6 py-3 border border-gray-500/30 bg-gray-800/20 rounded-lg backdrop-blur-sm
                           hover:bg-gray-700/40 hover:border-gray-400 transition-all duration-300 group"
                >
                  <span className="font-exo text-base text-gray-300 group-hover:text-white transition-colors">
                    Continue as Guest
                  </span>
                </button>
                <p className="text-xs text-center text-gray-500 mt-2">
                  Limited access • Sign in to save insights and sync calendar
                </p>
              </>
            )}
          </>
        ) : (
            <>
                <div className="text-center">
                    <h2 className="font-exo text-3xl font-bold text-white">Reset Credentials</h2>
                    <p className="mt-2 text-cyan-300">Enter your email to receive a reset link</p>
                </div>
                <form className="space-y-4" onSubmit={handleForgotPasswordSubmit}>
                    <InputField icon={<UserIcon />} type="email" placeholder="Email Address" value={email} onChange={(e) => setEmail(e.target.value)} />
                    <button type="submit" className="w-full font-exo text-lg py-3 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-slate-900 font-bold transition-all duration-300 shadow-lg shadow-cyan-500/20 btn-glow">
                        Send Reset Link
                    </button>
                </form>
                <div className="text-center">
                    <button type="button" onClick={() => setView('login')} className="text-sm text-cyan-400 hover:underline">Back to Login</button>
                </div>
            </>
        )}
      </div>
    </div>
  );
};

export default LoginScreen;
