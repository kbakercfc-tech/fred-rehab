# Database Persistence Instructions for Render Deployment

This document explains how to ensure your development database (`rehab.db`) and uploaded files (`public/uploads`) do not overwrite your production data on Render during deployments.

**The core idea is:**
1.  **Exclude** your local development database and uploads from your Git repository.
2.  **Utilize** Render's Persistent Disk feature for your production database and uploads.

**Please follow these steps carefully:**

### 1. Exclude your database and uploads from Git tracking (`.gitignore`)

This is the most critical step to prevent your local `rehab.db` file and the `public/uploads` directory from being included in your Git repository.

*   **Open the `.gitignore` file** in the root of your `fred-rehab` project.
    *   If you don't have a `.gitignore` file, create one in the same directory as your `package.json` and `index.js`.
*   **Add the following lines** to your `.gitignore` file:
    ```
    rehab.db
    /public/uploads/
    ```
*   **Save the `.gitignore` file.**

*   **Crucial Step - Untrack if already committed:**
    *   If `rehab.db` or `public/uploads` were *ever* committed to your Git repository before, Git is still tracking them. You need to untrack them:
        *   Open your terminal or command prompt and navigate to your `fred-rehab` project directory.
        *   Run these commands:
            ```bash
            git rm --cached rehab.db
            git rm --cached -r public/uploads
            ```
        *   (If you get an error like "pathspec 'rehab.db' did not match any files" it means Git was not tracking it, which is good. You can ignore those errors.)
*   **Commit this change to Git and push to GitLab:**
    *   ```bash
        git add .gitignore
        git commit -m "Add rehab.db and public/uploads to .gitignore"
        git push origin main
        ```
    *   (Replace `main` with `master` if your main branch is named 'master'.)

### 2. Leverage Render's Persistent Disks for Production Data

You should have already configured this as part of the Render deployment instructions in `DEPLOYMENT.md` (Option 2.1). This step ensures that your production data is stored on a persistent volume.

*   **Ensure your Render Web Service has a Persistent Disk configured.**
    *   **Mount Path:** It should be something like `/var/data`.
*   **Ensure your application is configured to use this path.**
    *   In your `index.js` file, you should have `const DB_PATH = process.env.DATABASE_PATH || './rehab.db';` and `const UPLOAD_DESTINATION = process.env.UPLOAD_PATH || 'public/uploads/';`.
    *   On Render, you should have environment variables set:
        *   `DATABASE_PATH = /var/data/rehab.db`
        *   `UPLOAD_PATH = /var/data/uploads`

**How it works:**

*   When Render deploys your app, it pulls the code from GitLab (which now *ignores* `rehab.db` and `public/uploads`).
*   Your application on Render then connects to the `rehab.db` file and uses the `/uploads` directory located on the **Persistent Disk**. This disk retains its data across deploys, restarts, and instance changes, ensuring your production data is never overwritten by your development files.
*   The `CREATE TABLE IF NOT EXISTS` logic in your `index.js` will automatically create the database tables if `rehab.db` is newly created on the Persistent Disk.

### 3. Initial Data (if any) for Production

*   If you have an existing `rehab.db` file from your local development environment that contains data you want to use as a starting point for production, you would need to manually upload that `rehab.db` file to your Render Persistent Disk. Render typically provides SFTP access for this, but this is a one-time manual transfer, not part of automated deployment.

By following these steps, your local development data will be completely separate and safe from your live production data.
