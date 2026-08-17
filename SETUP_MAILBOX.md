# Mailbox Setup — Jab Live Mailbox Mil Jaye

Poora automation pipeline (email fetch → client match → attachment save →
category assign → dashboard) already ready hai. Jaise hi ek real/test
mailbox available ho, bas ye 3 steps follow karo — koi extra code likhne
ki zaroorat nahi.

## Step 1 — `.env` mein mailbox email set karo

`backend/.env` file kholo aur `TEST_MAILBOX_EMAIL` ki value fill karo:

```
TEST_MAILBOX_EMAIL=someone@yourcompany.com
```

Ye wahi mailbox honi chahiye jise `TENANT_ID` / `CLIENT_ID` / `CLIENT_SECRET`
(Azure app registration) access kar sake — matlab admin ne is mailbox ko
Microsoft Graph app permissions (`Mail.Read`, `Mail.ReadWrite`) ke through
accessible banaya ho.

## Step 2 — Inbox processor chalao

```bash
cd backend
node processInbox.js
```

Ye script:
1. `TEST_MAILBOX_EMAIL` se recent emails fetch karegi (Graph API).
2. Har email ke sender ko clients ke against match karegi.
3. Match milne par attachments `backend/storage/{ClientName}/` mein save
   karegi, `FileLog` entries banayegi, aur mailbox par email ko
   "Processed" category assign karegi.
4. Match na milne par email ko Review Queue mein daal degi.
5. End mein summary print karegi — kitni emails fetch hui, kitni matched,
   kitni review-queue mein gayin, kitni duplicate skip hui.

Agar `TEST_MAILBOX_EMAIL` set nahi hai, script clearly bata degi aur exit
ho jayegi — koi silent failure nahi.

## Step 3 — Dashboard khol kar result dekho

```bash
cd backend && node server.js      # ek terminal mein
cd frontend && npm run dev        # dusre terminal mein
```

Browser mein `http://localhost:5173` kholo — Stats Bar, Review Queue,
aur Recent Activity sab automatically updated data dikhayenge, kyunki wo
seedhe database se hi fetch karte hain.

## Notes

- Agar kisi email ka sender kisi client se match nahi hota, wo Review
  Queue mein chala jayega — dashboard se manually "Assign Client" karke
  resolve kar sakte ho (already functional hai).
- Category assignment fail ho (jaise permission issue) to bhi baaki
  pipeline (file save, EmailLog, matching) rukega nahi — sirf error log
  hoga console mein.
- Dobara `node processInbox.js` chalane par pehle se processed emails
  (same `messageId`) duplicate ke roop mein automatically skip ho jayengi.
