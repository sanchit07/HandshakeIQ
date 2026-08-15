import React, { useState, useEffect } from 'react';
import { BackIcon } from './icons/UIIcons';
import { GoogleIcon, ZohoIcon, MicrosoftIcon } from './icons/BrandIcons';
import { useAuth } from '../client/hooks/useAuth';


interface SettingsScreenProps {
    onBack: () => void;
    userEmail: string;
}

const SettingsSection: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
    <div className="p-6 bg-gray-900/50 border border-cyan-600/20 rounded-lg">
        <h3 className="font-exo text-lg text-cyan-300 mb-4 border-b border-cyan-500/20 pb-2">{title}</h3>
        <div className="space-y-4">
            {children}
        </div>
    </div>
);

const inputClass = "w-full px-4 py-2 bg-gray-900/50 border border-cyan-500/30 rounded-lg text-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-cyan-400";

const ChangePasswordForm: React.FC = () => {
    const [currentPassword, setCurrentPassword] = useState('');
    const [newPassword, setNewPassword] = useState('');
    const [confirmPassword, setConfirmPassword] = useState('');
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const handleSubmit = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        if (newPassword !== confirmPassword) {
            setMessage({ type: 'error', text: 'New passwords do not match.' });
            return;
        }
        setSubmitting(true);
        try {
            const res = await fetch('/api/auth/change-password', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ currentPassword, newPassword }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setMessage({ type: 'error', text: data.message || 'Failed to change password.' });
                return;
            }
            setMessage({ type: 'success', text: 'Password changed successfully.' });
            setCurrentPassword('');
            setNewPassword('');
            setConfirmPassword('');
        } catch {
            setMessage({ type: 'error', text: 'Network error. Please try again.' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <form className="space-y-4" onSubmit={handleSubmit}>
            <input type="password" placeholder="Current Password" required value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} className={inputClass} />
            <input type="password" placeholder="New Password (min 8 characters)" required minLength={8} value={newPassword} onChange={(e) => setNewPassword(e.target.value)} className={inputClass} />
            <input type="password" placeholder="Confirm New Password" required value={confirmPassword} onChange={(e) => setConfirmPassword(e.target.value)} className={inputClass} />
            {message && (
                <p className={`text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>
            )}
            <button type="submit" disabled={submitting} className="w-full py-2 font-bold text-slate-900 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg transition-colors btn-glow font-exo">
                {submitting ? 'Updating...' : 'Change Password'}
            </button>
        </form>
    );
};

interface AppUser {
    id: string;
    email: string | null;
    firstName: string | null;
    lastName: string | null;
    isAdmin: boolean | null;
    createdAt: string | null;
}

const UserManagement: React.FC = () => {
    const [users, setUsers] = useState<AppUser[]>([]);
    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [makeAdmin, setMakeAdmin] = useState(false);
    const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
    const [submitting, setSubmitting] = useState(false);

    const loadUsers = async () => {
        try {
            const res = await fetch('/api/admin/users');
            if (res.ok) {
                setUsers(await res.json());
            }
        } catch {
            // silently ignore; list just won't render
        }
    };

    useEffect(() => { loadUsers(); }, []);

    const handleCreate = async (e: React.FormEvent) => {
        e.preventDefault();
        setMessage(null);
        setSubmitting(true);
        try {
            const res = await fetch('/api/admin/users', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ email, password, isAdmin: makeAdmin }),
            });
            const data = await res.json().catch(() => ({}));
            if (!res.ok) {
                setMessage({ type: 'error', text: data.message || 'Failed to create user.' });
                return;
            }
            setMessage({ type: 'success', text: `User ${data.email} created successfully.` });
            setEmail('');
            setPassword('');
            setMakeAdmin(false);
            loadUsers();
        } catch {
            setMessage({ type: 'error', text: 'Network error. Please try again.' });
        } finally {
            setSubmitting(false);
        }
    };

    return (
        <div className="space-y-6">
            <form className="space-y-4" onSubmit={handleCreate}>
                <input type="email" placeholder="New user's email address" required value={email} onChange={(e) => setEmail(e.target.value)} className={inputClass} />
                <input type="password" placeholder="Password (min 8 characters)" required minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
                <label className="flex items-center space-x-2 text-sm text-gray-300 cursor-pointer">
                    <input type="checkbox" checked={makeAdmin} onChange={(e) => setMakeAdmin(e.target.checked)} className="accent-cyan-500" />
                    <span>Grant admin privileges</span>
                </label>
                {message && (
                    <p className={`text-sm ${message.type === 'success' ? 'text-green-400' : 'text-red-400'}`}>{message.text}</p>
                )}
                <button type="submit" disabled={submitting} className="w-full py-2 font-bold text-slate-900 bg-cyan-600 hover:bg-cyan-500 disabled:opacity-50 rounded-lg transition-colors btn-glow font-exo">
                    {submitting ? 'Creating...' : 'Create User'}
                </button>
            </form>

            {users.length > 0 && (
                <div>
                    <h4 className="text-sm text-gray-400 mb-2">Existing users</h4>
                    <div className="space-y-2">
                        {users.map((u) => (
                            <div key={u.id} className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                                <div>
                                    <p className="text-white text-sm font-medium">{u.email || '(no email)'}</p>
                                    <p className="text-xs text-gray-500">{u.createdAt ? new Date(u.createdAt).toLocaleDateString() : ''}</p>
                                </div>
                                {u.isAdmin && (
                                    <span className="text-xs px-2 py-1 bg-cyan-900/60 border border-cyan-500/40 text-cyan-300 rounded-full">Admin</span>
                                )}
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    );
};

const SettingsScreen: React.FC<SettingsScreenProps> = ({ onBack, userEmail }) => {
    const { isAdmin } = useAuth();

    return (
        <div className="h-full flex flex-col p-4 bg-black/30 border border-cyan-500/20 rounded-lg backdrop-blur-md overflow-y-auto animate-fade-in">
            <div className="flex-shrink-0 flex items-center justify-between mb-6">
                <button onClick={onBack} className="flex items-center space-x-2 text-cyan-300 hover:text-white transition-colors">
                    <BackIcon />
                    <span className="font-bold font-exo">Back to Dashboard</span>
                </button>
                <h2 className="font-exo text-2xl text-white">Settings</h2>
            </div>

            <div className="max-w-2xl mx-auto w-full space-y-6">
                {isAdmin && (
                    <SettingsSection title="User Management (Admin)">
                        <UserManagement />
                    </SettingsSection>
                )}

                <SettingsSection title="Account Security">
                    <ChangePasswordForm />
                </SettingsSection>

                <SettingsSection title="Calendar Sync">
                     <p className="text-sm text-gray-400">Manage calendars associated with <span className="font-bold text-cyan-300">{userEmail}</span>.</p>
                    <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <GoogleIcon />
                            <div>
                                <p className="font-bold text-white">Google Calendar</p>
                                <p className="text-sm text-green-400">Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-yellow-300 border border-yellow-400/50 rounded-full hover:bg-yellow-900/50 transition-colors btn-glow">
                            Unsync
                        </button>
                    </div>
                     <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <ZohoIcon />
                            <div>
                                <p className="font-bold text-white">Zoho Calendar</p>
                                <p className="text-sm text-gray-400">Not Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors btn-glow">
                            Sync
                        </button>
                    </div>
                     <div className="flex justify-between items-center p-3 bg-gray-900/40 rounded-md">
                        <div className="flex items-center space-x-3">
                            <MicrosoftIcon />
                            <div>
                                <p className="font-bold text-white">Microsoft Calendar</p>
                                <p className="text-sm text-gray-400">Not Synced</p>
                            </div>
                        </div>
                        <button className="px-4 py-1 text-sm text-cyan-300 border border-cyan-400/50 rounded-full hover:bg-cyan-900/50 transition-colors btn-glow">
                            Sync
                        </button>
                    </div>
                </SettingsSection>
            </div>
        </div>
    );
};

export default SettingsScreen;
