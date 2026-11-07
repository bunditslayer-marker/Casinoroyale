# Black Tie Poker

A private Texas Hold'em table for you and your friends. Open the link, type your name, and play from your phone. Play chips only, no real money.

- 2 to 8 players per table, each table has a 4-letter code
- Full Texas Hold'em rules: blinds, minimum raises, all-ins, side pots, split pots
- The server deals, so nobody can peek at anyone else's cards
- Turn timer, sit out, rebuy, standings, hand log and chat
- The name "Marker" is reserved for the founder: anyone who types it (or a lookalike such as "Mark3r") must enter the secret code. The founder gets a jewelled gold crown and a gold seat at every table
- Admin controls (the person who creates the table gets the crown): any blinds such as 1/2, an optional ante, starting chips, turn timer, and the table and background colours
- Refresh or lose signal and you get your seat back

---

## Put it online for free (about 15 minutes)

You need a laptop or desktop for this. You only do it once.

### 1. Put the code on GitHub

This works on a phone or a laptop. All the files sit in one folder, so you can upload them in one go.

1. Unzip the zip file. On iPhone: open it in the Files app, press and hold it, and tap **Uncompress**.
2. Go to **github.com** and sign up (free).
3. Tap **+**, then **New repository**. Name it `black-tie-poker` and tap **Create repository**.
4. On the next page, tap **uploading an existing file**.
5. Tap **choose your files**, then **Choose File**. Open the unzipped `black-tie-poker` folder, tap **Select**, select all 10 files, and tap **Open**.
6. Wait for the files to upload, then tap **Commit changes**.

Check: your repository should show 10 files, including `server.js`, `index.html` and `package.json`.

### 2. Host it on Render

1. Go to **render.com** and click **Get Started**. Sign up with your GitHub account.
2. Click **New**, then **Web Service**.
3. Choose your `black-tie-poker` repository. If it isn't listed, click the option to configure your GitHub account and give Render access to it.
4. Fill in the settings:
   - **Language:** Node
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** Free
5. Click **Deploy Web Service** and wait 2 to 3 minutes until it says **Live**.
6. Your site's address is at the top of the page, something like `https://black-tie-poker.onrender.com`.

### 3. Play

Open your address, type your name, and tap **Create a table**. Tap **Invite** and send the link to your group chat. When everyone has sat down, tap **Start game**.

You're the admin of any table you create, shown by the crown next to your name. Tap the crown at the top of the screen to change the blinds, ante, chips, timer or colours. Rule changes start from the next hand, and colours change for everyone as soon as you save. If the admin leaves, the next player becomes admin.

### The founder's secret code

The code is never written in the project. `owner.js` only holds a scrambled version that can't be turned back into the code, and the server blocks anyone who gets it wrong 5 times for 10 minutes.

To change the code, open your service on Render, go to **Environment**, and add a variable named `OWNER_CODE` with the new code as its value. Save, and Render restarts with the new code.

Tip: to keep the whole project private, open your repository on GitHub, then go to **Settings**, scroll to **Danger Zone**, and choose **Change visibility** → **Private**. Render keeps working.

### Good to know about the free plan

- If nobody uses the site for 15 minutes, Render puts it to sleep. The next visit takes about a minute to wake it up. Open the site a minute before you play.
- When the site sleeps or restarts, open tables close. Just create a new one.
- To change something later, edit the file on GitHub (click the file, then the pencil icon) and commit. Render updates the site automatically.

---

## Run it on your own laptop (optional)

1. Install Node.js from **nodejs.org** (the LTS version).
2. Open a terminal in the `black-tie-poker` folder and run:
   ```
   npm install
   npm start
   ```
3. Open `http://localhost:3000`.

Friends on the same Wi-Fi can join using your laptop's local IP address, for example `http://192.168.1.20:3000`.


---

## Make it yours

| What | Where |
|---|---|
| Colour choices in the admin menu | `FELTS` and `ROOMS` near the top of `client.js` |
| Other colours (brass, cards) | Top of `style.css` |
| Name and home page text | `index.html` |
| Default chips, blinds, ante, timer, colours | `DEFAULT_SETTINGS` in `game.js` |
| Poker rules | `game.js` |
| Hand rankings | `evaluator.js` |
| How the page works | `client.js` |
| Tables, codes, connections | `server.js` |
| Reserved name and secret code check | `owner.js` |
