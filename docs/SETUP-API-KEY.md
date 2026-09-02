# Getting Your AssemblyAI API Key

Follow these steps to set up AssemblyAI and get your API key running on your local machine.

## Step 1: Sign up for AssemblyAI

1. Go to https://www.assemblyai.com/dashboard/signup
2. Choose either:
   - **Continue with Google** (if you have a Google account), or
   - **Continue with email** (enter your email address)
3. Complete the sign-up process
4. **No credit card is required.** You'll automatically receive $50 in free credits that work for all APIs (Voice Agents, real-time transcription, and more). These credits never expire.

**Source:** https://www.assemblyai.com/dashboard/signup and https://www.assemblyai.com/docs/billing-and-pricing (VERIFIED)

## Step 2: Get your API key from the dashboard

Once signed in:

1. Click on **Workspace** in the left sidebar
2. Click **Manage** 
3. Click **API Keys**
4. Click the **Create New API Key** button
5. Give it a name (e.g., "countersign-local")
6. Click **Create**
7. Copy the key that appears (this is your only chance to see it—copy it now)

**Source:** https://www.assemblyai.com/docs/account-management (VERIFIED)

## Step 3: Store your API key securely

1. Open a terminal in the `countersign` folder (the root of this repo)
2. Create a file named `.env`:
   ```
   ASSEMBLYAI_API_KEY=paste_your_key_here
   ```
3. Replace `paste_your_key_here` with the actual key you copied in Step 2
4. **Never paste your API key into chat, email, Discord, or any commit message.**
5. The `.env` file is already in `.gitignore`, so it will not be committed to git

**Example:**
```
ASSEMBLYAI_API_KEY=paste-your-key-here
```

## What you get for free

- **$50 in credits** (no expiration)
- **Voice Agent API** (no separate setup needed—your API key works immediately)
- **5 new concurrent streams per minute** (upgrade to paid plan for higher limits)
- All credits cover: pre-recorded transcription, real-time transcription, Voice Agents, and Speech Understanding

**Source:** https://www.assemblyai.com/docs/billing-and-pricing (VERIFIED)

## Next steps

Once your `.env` file is in place with your API key, the application is ready to use AssemblyAI. See the main README for how to run the application.

---

## Troubleshooting

**"API key not found" error when running the app?**
- Make sure the `.env` file is in the root of the `countersign` folder (same level as package.json)
- Make sure the line is exactly: `ASSEMBLYAI_API_KEY=your_key_here`
- Restart your development server after creating/editing the `.env` file

**Can't create an API key in the dashboard?**
- Contact AssemblyAI support: support@assemblyai.com
- Your account must have at least one active API key to use the service

**Ran out of free credits?**
- Add a payment method in your dashboard under **Workspace** > **Billing** to continue
- Your free $50 credit never expires; you only need to pay when you use it up
