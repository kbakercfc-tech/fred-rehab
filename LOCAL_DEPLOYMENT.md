# Local Deployment Instructions for Fred's Laptop

This document outlines the simplest way for Fred to run the Fred Rehab application directly on his laptop.

**Steps:**

1.  **Ensure Node.js is Installed:**
    Fred will need Node.js and npm (Node Package Manager) installed on his laptop. He can download the installer from the official Node.js website:
    [https://nodejs.org/](https://nodejs.org/)

2.  **Get the Application Files:**
    You will need to provide Fred with the entire `fred-rehab` folder. You can transfer it via a USB drive, a cloud storage service, or by zipping it and sending it to him.

3.  **Install Application Dependencies:**
    *   Fred needs to open a terminal or command prompt on his laptop.
    *   He should then navigate to the `fred-rehab` folder using the `cd` command. For example, if the folder is in his Downloads:
        ```bash
        cd C:\Users\Fred\Downloads\fred-rehab
        ```
    *   Once inside the `fred-rehab` folder, he needs to run the following command to install all necessary libraries:
        ```bash
        npm install
        ```

4.  **Run the Application:**
    After the dependencies are installed, he can start the application from the same terminal window by running:
    ```bash
    node index.js
    ```

5.  **Access the Application:**
    Once the application starts, it will typically be accessible in his web browser at the following address:
    `http://localhost:3000`

    He can then navigate to the different parts of the application:
    *   `http://localhost:3000/` (for entering new data)
    *   `http://localhost:3000/history.html` (to view historical data in a table)
    *   `http://localhost:3000/steps-graph.html` (to view the steps graph)
    *   `http://localhost:3000/exercise-videos.html` (to upload and view exercise videos)

---

**Important Notes for Local Use:**

*   **Data Persistence:** The data (exercises, steps, video metadata) is stored in a file called `rehab.db` inside the `fred-rehab` folder. As long as he keeps this folder and its contents intact, his data will be preserved.
*   **Keeping it Running:** The `node index.js` command will keep the application running as long as the terminal window remains open. If he closes that terminal window, the application will stop. For typical personal use on a laptop, this is often acceptable.
*   **Internet Access:** After the initial `npm install` (which requires internet to download packages), the application runs entirely locally and does not require an internet connection to function.
