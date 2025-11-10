# HandshakeIQ Testing Guide

## ✅ What's Been Fixed:

### 1. Logo Placement
- **Left Side (HandshakeIQ)**: Now shows Moving Walls logo image
- **Right Side**: Shows "Powered by MOVINGWALLS" text (as before)

### 2. Dashboard Display Logic
- **With Zoho Login (Test Mode)**: Shows mock/demo meeting data
- **With Google Login (Real Calendar)**: Shows actual Google Calendar events
- **Fallback**: If no calendar events, shows demo data

---

## 🧪 Testing Steps:

### **Test 1: Zoho Login (Mock Data)**
1. Click **"Sign in with Zoho"**
2. You'll be logged in as: **Sanchit Neema** (sanchit@movingwalls.com)
3. Dashboard should show:
   - ✅ Search bar
   - ✅ **"Upcoming Transmissions (Demo Data)"** section
   - ✅ Mock meetings with clickable participants
4. Test clicking on participants to generate AI insights

### **Test 2: Google Calendar Sync (Real Data)**
1. Log out (if already logged in with Zoho)
2. Click **"Sign in with Google"**
3. Authorize with your Google account
4. **Grant calendar permissions** when prompted
5. Dashboard should show:
   - ✅ **"Today & Tomorrow"** section with real meetings
   - ✅ Your actual calendar events
   - ✅ Clickable participants

### **Test 3: Upcoming Meetings Page**
1. After signing in with Google
2. Click **menu icon** (top right)
3. Select **"Upcoming Meetings"**
4. Should display:
   - ✅ Next 30 days of meetings
   - ✅ Full participant lists
   - ✅ All participants are clickable

---

## 🔑 Important Notes:

### Google Calendar Requirements:
- You must use **real Google Sign-In** (not Zoho)
- Calendar scope: `calendar.readonly`
- If you signed in before, you may need to re-authenticate to grant calendar access

### Demo vs Real Data:
- **Zoho login** = Mock data (for testing without calendar)
- **Google login** = Real calendar events (requires calendar permission)

### OAuth Redirect URI:
- Currently configured for development
- After publishing, update Google Cloud Console with production redirect URI:
  - Format: `https://[your-domain]/auth/google/callback`

---

## 🎯 Expected Behavior:

| Login Method | Dashboard Shows | Calendar Sync |
|--------------|-----------------|---------------|
| Guest Mode | Nothing (search only) | ❌ Not available |
| Zoho Login | Mock meetings | ❌ Not available |
| Google Login | Real calendar events | ✅ Available |

---

## 🐛 Troubleshooting:

**Calendar not showing?**
- Make sure you granted calendar permission during Google OAuth
- Check browser console for errors
- Try logging out and re-authenticating

**Shows demo data instead of calendar?**
- You might be using Zoho login (which doesn't have calendar access)
- Sign in with Google instead

**Participants not clickable?**
- Make sure you're logged in (not guest mode)
- Check that attendees have email addresses

