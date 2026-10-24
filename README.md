# STI Alaminos Research Library

This web application runs on the computer or server hosting its backend. It can store account and paper records in SQLite, MongoDB Atlas, or Neon PostgreSQL. Uploaded research documents use local storage for the private Tailscale setup, or Cloudflare R2 for a Vercel deployment. The library and keyword-based research assistant do not require an AI provider or paid API.

## Start the application

1. Install Node.js 22.13 or newer. The local SQLite fallback requires a recent Node.js version. If `node` is not recognized in a terminal after installation, restart VS Code so its terminal reloads the updated PATH.
2. Open PowerShell in the project folder:

   ```powershell
   cd "C:\Users\Marjorie\Documents\htmlprojj"
   ```

3. Install the free server dependencies once:

   ```powershell
   npm.cmd install
   ```

4. Start the website:

   ```powershell
   npm.cmd start
   ```

5. Visit <http://localhost:3000/research.html>. Leave the terminal open while using the app. Stop the server with `Ctrl+C`.

Do not open `research.html` directly as a `file://` page; use the local URL above so accounts, documents, and the database work.

## Accounts and permissions

- The library, search, assistant, paper previews, downloads, and submissions require a signed-in account. Visitors see only the account screen until they sign in.
- Create an account from the Log in window.
- The first account created on a new local database becomes Admin.
- Later self-registered accounts are Students by default.
- Students can submit research papers for Admin review. Pending papers are not visible in the library or downloadable until approved.
- Students can check pending, approved, and rejected submissions from **My submissions**.
- Admins can approve or reject submissions from **Review submissions**. Rejected documents are removed from local storage.
- Admins can create accounts, change roles, reset a user's password, or remove accounts.
- Faculty and Admin accounts can publish and manage papers directly.
- Signed-in users can download documents.

Passwords are hashed on the local server. Sessions are held in an HTTP-only cookie and expire after inactivity. This local application listens only on this computer; it is not configured for school-network or public access.

## Private access for groupmates with Tailscale

The app can be shared privately with trusted Tailscale users while it runs on this computer. Everyone needs to be invited to the same Tailscale network and have Tailscale connected. The host computer must stay on, connected to the internet, and running the app. For HTTPS access, Tailscale Serve proxies to the app on localhost; the app still binds only to `127.0.0.1`.

1. In the Tailscale admin console, invite each trusted groupmate to your tailnet. Have each person install Tailscale on their own computer and sign in with their own invited account. Do not share your account password.
2. Enable MagicDNS if needed. In the Tailscale admin console, find your computer's MagicDNS name. It looks like `computer-name.your-tailnet.ts.net`; use its HTTPS origin, for example `https://computer-name.your-tailnet.ts.net`.
3. Create a local environment file in the project folder, which is excluded from source control:

   ```powershell
   Copy-Item .env.example .env
   ```

   Open `.env` in VS Code and set `PUBLIC_ORIGIN` to your exact HTTPS MagicDNS origin. Keep `HOST=127.0.0.1`. Use `ALLOW_PASSWORD_SIGNUP=true` for username/password accounts; set it to `false` if you want Admin-created accounts only or restrict account creation to approved Google test users.
4. Start the app in the VS Code terminal:

   ```powershell
   $env:HOST = "127.0.0.1"
   npm.cmd start
   ```

5. In the same computer's terminal, enable the private HTTPS proxy:

   ```powershell
   tailscale serve --bg 3000
   tailscale serve status
   ```

   Confirm Tailscale shows the same `https://...ts.net` address you entered as `PUBLIC_ORIGIN`. This is private to your tailnet; do not enable Funnel.
6. In Google Cloud Console, create a project and configure its OAuth consent screen for **External** users in **Testing** mode. Add each groupmate's Google email under **Test users**. Google sign-in is limited to the test users you add until you complete Google's review and publish the app.
7. Create an OAuth client with application type **Web application**. Add this exact **Authorized redirect URI**, replacing the example host with your MagicDNS name:

   ```text
   https://computer-name.your-tailnet.ts.net/auth/google/callback
   ```

   Copy the client ID and secret into `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.env`. Never share the client secret or commit `.env`.
8. Restart the app after editing `.env`. Groupmates connect Tailscale, then visit `https://computer-name.your-tailnet.ts.net/research.html` and choose **Continue with Google**. Only the Google accounts added as test users can sign in while the consent screen is in Testing mode.

Google sign-in creates new accounts as Students after the existing Admin account is set up. Existing password accounts aren't automatically linked to a Google identity. Keep the server terminal open and Tailscale connected while the group uses the app. Do not enable Tailscale Funnel, router port forwarding, or Windows firewall access from public networks. Invite only people you trust; anyone in the tailnet who knows the app address can reach its login page. Tailscale encrypts the connection between tailnet devices, but this is still a small private-group setup, not school-approved public hosting. Ask the school before storing real student data.

To switch back to computer-only access, stop the server and clear `PUBLIC_ORIGIN`, `GOOGLE_CLIENT_ID`, and `GOOGLE_CLIENT_SECRET` in `.env`, then run `npm.cmd start`. To move to another host later, back up the database and uploads together.

## Documents and backup

Upload PDF, DOCX, or TXT files up to 10 MB. With the local setup, file contents and paper metadata persist on this computer:

- SQLite database: `data\research.sqlite`
- Uploaded files: `data\uploads\`

When MongoDB Atlas is enabled, account and paper metadata are stored in Atlas instead of SQLite, but uploaded documents stay in `data\uploads\` on the server computer. Keep that folder available and back it up. The `data` folder is intentionally excluded from source control.

## Optional MongoDB Atlas database

Atlas stores account and paper metadata in the cloud; it does not host this website or the uploaded documents. Your computer must still be on, connected to Tailscale, and running the app for groupmates to use it. Before switching, make a backup of the entire `data` folder and check that cloud storage is allowed for your group's research data.

1. Create a free Atlas cluster and a database user with a strong, unique password.
2. In **Network Access**, allow the server computer's current public IP address. Do not use `0.0.0.0/0` for this private group setup. If your internet provider changes your public IP, update the Atlas access list.
3. Copy the cluster's Node.js connection string. Keep its password private and URL-encode special characters in it as Atlas instructs.
4. Put the connection string in the local `.env` file as `MONGODB_URI=...`. Leave `MONGODB_DATABASE=sti_research_hub`, save the file, and restart the server.
5. On the first connection, the app automatically imports users, sessions, and paper metadata from `data\research.sqlite` only if the selected Atlas database is empty. The import does not copy uploaded files; keep `data\uploads\` on the server. The local SQLite database is left unchanged as a pre-migration snapshot, but changes made after switching to Atlas are not written back to it.

The app refuses to import into an Atlas database that already contains app data without its import marker, rather than overwriting that data. Back up both the local database and uploads before switching. Do not share or commit `.env`, which contains the Atlas connection string. A free cluster should not be treated as the only backup of important work.

## Prepare a Vercel deployment

A Vercel deployment is reachable from the public internet; it is not protected by your Tailscale tailnet. The application keeps password self-signup disabled on Vercel, and an Admin must create each group account. Share the URL only with intended groupmates, use unique strong passwords, and get school approval before placing real student or research data in hosted services.

Vercel functions use changing outbound IP addresses by default, while Atlas requires IP allowlisting. Do not solve this by allowing `0.0.0.0/0`. Vercel's static egress IP option is a paid Pro/Enterprise feature. The deployment therefore uses Neon PostgreSQL for database records and a private Cloudflare R2 bucket for document files. Atlas remains unchanged as the migration source and rollback copy.

### Create the hosted services

1. Create a Neon PostgreSQL project. Copy its pooled connection string and keep it private.
2. In Cloudflare, create a **private** R2 bucket. Create an R2 API token scoped only to that bucket with object read/write access. Record the account ID, access key ID, and secret access key.
3. Configure the bucket's CORS policy for the exact Vercel production origin. Allow `PUT` and the `Content-Type` request header. Do not enable public bucket access.
4. Add these values to the local `.env` file without removing `MONGODB_URI`; the migration uses Atlas as its source:

   ```text
   DATABASE_URL=<Neon pooled connection string>
   R2_ACCOUNT_ID=<Cloudflare account ID>
   R2_ACCESS_KEY_ID=<bucket-scoped R2 access key>
   R2_SECRET_ACCESS_KEY=<R2 secret>
   R2_BUCKET_NAME=<private bucket name>
   ```

   Never paste these values into chat or commit `.env`.

### Migrate the existing data

Back up the project `data` folder first. Then run this in the project directory:

```powershell
npm.cmd run migrate:vercel-data
```

The one-time migration copies user accounts, sessions, paper metadata, and existing approved/pending document files from Atlas plus the local `data\uploads\` folder into Neon and private R2. It refuses to overwrite a non-empty Neon database. Atlas and the local uploads are left intact as rollback copies. Do not deploy until the migration reports success; if it fails, keep the source data and share only the error text, never a connection string.

### Deploy and configure Vercel

1. Push the source code to a **private GitHub repository**. `.gitignore` excludes `.env`, `data`, `node_modules`, generated `public` assets, and root-level text documents. Review GitHub's upload list and ensure no paper files or secrets are included.
2. In Vercel, import the private repository. The project is configured as an Express app; its build step copies the website assets into `public/`.
3. In **Project → Settings → Environment Variables**, add `DATABASE_URL`, `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, and `R2_BUCKET_NAME` for the **Production** environment. Set `PUBLIC_ORIGIN` to the exact HTTPS production domain, for example `https://your-project.vercel.app`. Do not add `MONGODB_URI` to Vercel. Password self-signup is disabled in Vercel deployments; leave `ALLOW_PASSWORD_SIGNUP` unset or `false`.
4. Redeploy after setting environment variables and the exact R2 CORS origin. Test Admin login, catalog access, upload, Admin review, and authenticated document download before inviting groupmates.
5. Create each groupmate's account in the Admin **Manage users** page and share their credentials privately. Do not share the Admin password. Google sign-in, if configured, can only authenticate a Google identity already linked to an account; it cannot create new Vercel accounts.

Deploy previews are also internet-reachable. Do not give previews production database or storage credentials; if you need preview testing, create separate test services and use test data only. Never add the Atlas, Neon, or R2 secrets to GitHub. Vercel and Cloudflare free-plan allowances and pricing can change; review current limits and backups before relying on them.

## Research assistant

The assistant runs free, local keyword and phrase matching across saved paper titles, authors, topics, courses, and abstracts. It can surface papers, show abstracts, and provide basic catalog comparisons. It is not a generative AI model and does not send paper information to an external service.

## Limits

This is a small-group application, not a general public service. A Vercel deployment is internet-reachable and the configuration does not replace school approval or a thorough security review. Plan for backups, monitoring, account recovery, and ongoing maintenance before relying on it for important data.
