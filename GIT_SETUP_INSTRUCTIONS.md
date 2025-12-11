# Git Repository Setup Instructions

This document outlines how to initialize your `fred-rehab` project as a Git repository and prepare it for deployment to services like Render.

**Please follow these steps carefully:**

1.  **Ensure Git is Installed:**
    *   If you don't have Git installed on your computer, please download and install it first from the official website: [https://git-scm.com/downloads](https://git-scm.com/downloads)

2.  **Open your Terminal or Command Prompt:**
    *   You can usually find this by searching for "cmd" or "PowerShell" on Windows, or "Terminal" on macOS/Linux.

3.  **Navigate to your `fred-rehab` project directory:**
    *   In your terminal, use the `cd` command. For example, if your `fred-rehab` folder is directly under your user directory:
        ```bash
        cd C:\Users\kbake\fred-rehab
        ```
    *   (Replace `C:\Users\kbake\fred-rehab` with the actual path to your project folder).

4.  **Check if it's already a Git repository (Optional):**
    *   To see if a `.git` folder (which indicates a Git repository) already exists, type one of these commands in your terminal:
        *   On Windows: `dir /a`
        *   On Linux/macOS: `ls -a`
    *   If you see a folder named `.git` listed, then your project is already a Git repository. You can skip to step 6. If not, proceed to step 5.

5.  **Initialize a new Git repository:**
    *   If `.git` folder was not found in step 4, create a new Git repository:
        ```bash
        git init
        ```
    *   You should see a message like "Initialized empty Git repository in C:/Users/kbake/fred-rehab/.git/".

6.  **Stage all your project files for commit:**
    *   This command tells Git to start tracking all files in your project:
        ```bash
        git add .
        ```
    *   (The `.` means "add all files in the current directory and its subdirectories").

7.  **Make your first commit:**
    *   This saves a snapshot of your current project state to the Git history:
        ```bash
        git commit -m "Initial commit of Fred Rehab application"
        ```
    *   You can change the message inside the quotes (`"..."`) to something more descriptive if you like.

---

**Next Steps for Render Deployment:**

After completing the steps above, your `fred-rehab` folder is now a local Git repository. For deployment to Render (or other platforms like GitHub, GitLab), you will typically need to create a **remote repository** on one of those services and then "push" your local changes to it. Render will then deploy directly from that remote repository.

*The instructions for connecting your local Git repository to a remote service (like GitHub) and deploying to Render are detailed in the `DEPLOYMENT.md` file.*

Let me know once you have completed these Git setup steps, and then we can discuss connecting to a remote repository or the Render deployment.
