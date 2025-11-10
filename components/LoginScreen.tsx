import React, { useState } from 'react';
import { GoogleIcon, ZohoIcon, LinkedInIcon } from './icons/BrandIcons';
import { UserIcon, LockIcon } from './icons/UIIcons';

const LoginButton: React.FC<{ icon: React.ReactNode; label: string; onClick: () => void }> = ({ icon, label, onClick }) => (
  <button
    onClick={onClick}
    className="w-full flex items-center justify-center space-x-4 px-6 py-3 border border-cyan-400/30 bg-cyan-900/20 rounded-lg backdrop-blur-sm
               hover:bg-cyan-700/40 hover:border-cyan-300 transition-all duration-300 group btn-glow"
  >
    <span className="text-cyan-300 group-hover:text-white transition-colors">{icon}</span>
    <span className="font-exo text-base text-cyan-200 group-hover:text-white transition-colors">{label}</span>
  </button>
);

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

const LoginScreen: React.FC = () => {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [view, setView] = useState<'login' | 'forgotPassword'>('login');

  const handleReplitAuth = () => {
    window.location.href = '/api/login';
  };

  const handleFormSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Redirect to Replit Auth
    handleReplitAuth();
  };
  
  const handleForgotPasswordSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    // Simulate sending a reset link
    alert(`Password reset link sent to ${email}`);
    setView('login');
  };

  return (
    <div className="flex items-center justify-center h-full">
      <div className="w-full max-w-md p-8 space-y-6 bg-black/30 rounded-2xl shadow-2xl shadow-cyan-500/10 border border-cyan-500/20 backdrop-blur-lg animate-slide-up-fade">
        {view === 'login' ? (
          <>
            <div className="text-center">
              <h2 className="font-exo text-3xl font-bold text-white">Access Terminal</h2>
              <p className="mt-2 text-cyan-300">Authenticate to access intelligence data</p>
            </div>
            <form className="space-y-4" onSubmit={handleFormSubmit}>
                <InputField icon={<UserIcon />} type="email" placeholder="Email Address" value={email} onChange={(e) => setEmail(e.target.value)} />
                <InputField icon={<LockIcon />} type="password" placeholder="Password" value={password} onChange={(e) => setPassword(e.target.value)} />
                <div className="text-right">
                    <button type="button" onClick={() => setView('forgotPassword')} className="text-sm text-cyan-400 hover:underline">Forgot Password?</button>
                </div>
                <button type="submit" className="w-full font-exo text-lg py-3 bg-cyan-600 hover:bg-cyan-500 rounded-lg text-slate-900 font-bold transition-all duration-300 shadow-lg shadow-cyan-500/20 btn-glow">
                    Engage
                </button>
            </form>
            <div className="relative flex items-center py-2">
                <div className="flex-grow border-t border-cyan-500/30"></div>
                <span className="flex-shrink mx-4 text-gray-400">Or continue with</span>
                <div className="flex-grow border-t border-cyan-500/30"></div>
            </div>
            <div className="space-y-3">
              <LoginButton icon={<GoogleIcon />} label="Sign in with Google" onClick={handleReplitAuth} />
              <LoginButton icon={<ZohoIcon />} label="Sign in with GitHub" onClick={handleReplitAuth} />
              <LoginButton icon={<LinkedInIcon />} label="Sign in with Email" onClick={handleReplitAuth} />
            </div>
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