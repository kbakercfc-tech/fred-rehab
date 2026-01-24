# Database Migration Instructions (for Render) - v2

This document provides the updated and simplified instructions for safely migrating your production database on Render.

---

### Prerequisites

1.  **Paid Render Plan**: SSH access is not available on Render's free plan.
2.  **SSH Key**: You must have an SSH key added to your Render account.

---

### Step 1: Connect to Your Render Service via SSH

1.  Go to your service on the [Render Dashboard](https://dashboard.render.com/).
2.  Click the **"Connect"** button and select the **"SSH"** tab.
3.  Copy the provided SSH command and run it in your local terminal to connect to your server.

You are now connected to your running application's server on Render.

### Step 2: Navigate to Your Application Directory

Your application code is located in the `/app` directory. Run the following command to go there:

```shell
cd /app
```

### Step 3: Backup Your Database

Now that you are in the correct directory, run the following command to back up your live database. This is a critical safety step.

```shell
cp /var/data/rehab.db /var/data/rehab.db.bak
```

This creates a backup file named `rehab.db.bak` in your persistent data directory.

### Step 4: Run the Migration Script

Run the migration script to update your database schema. The script now knows where to find the live database.

```shell
node migrate-database.js
```

### Step 5: Check the Output

The script will print "Migration successful!".

-   If successful, proceed to the next step.
-   If you see any errors, **stop immediately**. You can restore your backup by running: `cp /var/data/rehab.db.bak /var/data/rehab.db`

### Step 6: Disconnect and Deploy

1.  Type `exit` and press Enter to close the SSH connection.
2.  You can now deploy the new version of your application code. The database and the application are now in sync.
