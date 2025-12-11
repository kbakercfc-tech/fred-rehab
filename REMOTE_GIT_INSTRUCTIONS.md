# Connecting Your Local Git Repository to a Remote Server (GitHub)

This document provides instructions on how to link your existing local Git repository (your `fred-rehab` project) to a remote repository on GitHub, and then push your code to it. This is a crucial step for deploying to services like Render.

**Please follow these steps carefully:**

1.  **Ensure you have already completed the local Git setup steps:**
    *   You should have already run `git init`, `git add .`, and `git commit -m "..."` in your `fred-rehab` project folder.

2.  **Create a New Repository on GitHub.com:**
    *   Open your web browser and go to: [https://github.com/new](https://github.com/new)
    *   Log in to your GitHub account if prompted.
    *   **Repository name:** Type `fred-rehab` (or your preferred name) in the 'Repository name' field.
    *   **Description (Optional):** Add a short description.
    *   **Public or Private:** Choose 'Public' or 'Private'.
    *   **DO NOT check 'Add a README file', 'Add .gitignore', or 'Choose a license'.**
    *   Click the green **'Create repository'** button.

3.  **Get the Remote Repository URL:**
    *   After creating the repository on GitHub, you'll be taken to a page with instructions.
    *   Look for the section titled: "**...or push an existing local repository from the command line**".
    *   Copy the URL provided there. It will look something like `https://github.com/YOUR_USERNAME/fred-rehab.git`.

4.  **Open your Terminal or Command Prompt:**
    *   Navigate to your `fred-rehab` project directory.

5.  **Add the Remote Origin:**
    *   In your terminal, type the following command, replacing `YOUR_REMOTE_URL` with the URL you copied from GitHub in step 3:
        ```bash
        git remote add origin YOUR_REMOTE_URL
        ```
    *   *(Note: If you encounter an error like 'remote origin already exists', you can remove the old remote first by running: `git remote remove origin` then try the `git remote add origin` command again.)*

6.  **Rename your local branch to 'main' (if necessary) and Push to GitHub:**
    *   ```bash
        git branch -M main
        git push -u origin main
        ```
    *   You might be prompted to enter your GitHub username and password. If you have 2FA (Two-Factor Authentication) enabled, you'll need to use a Personal Access Token instead of your password. (GitHub will guide you on creating one if needed).

Once these steps are complete, your local `fred-rehab` project will be uploaded to GitHub, and Render should then be able to access it.
