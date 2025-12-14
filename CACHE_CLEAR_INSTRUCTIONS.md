# Cache Clearing and Tabular Data Entry Testing Instructions

This document provides instructions on how to clear your browser's cache and then test the default repetitions functionality on the "Enter Data - Tabular" page.

---

### **Step 1: Clear your browser's cache**

Sometimes browsers aggressively cache older versions of web pages (JavaScript, CSS, etc.). This can prevent you from seeing the latest changes. Clearing your cache forces the browser to fetch the most recent files.

There are two main methods to clear your cache:

#### **Method 1: Hard Refresh (Recommended for quick testing)**

This forces your browser to reload the page's resources directly from the server, bypassing its local cache.

*   **On Windows/Linux (for most browsers like Chrome, Firefox, Edge, Brave):**
    *   Press `Ctrl + F5`
    *   Alternatively, hold down `Ctrl` and click the "Reload" button in your browser's address bar.
*   **On Mac (for Chrome/Firefox):**
    *   Press `Cmd + Shift + R`
*   **On Mac (for Safari):**
    *   Press `Cmd + Option + R`

#### **Method 2: Clear from Browser Settings (More thorough)**

This clears the cache more globally or for a specific time range through your browser's settings.

*   **For Google Chrome:**
    1.  Click the three-dot menu in the top-right corner of the browser.
    2.  Go to `More tools` > `Clear browsing data...`
    3.  In the dialog, select a `Time range` (e.g., "Last hour" or "Last 24 hours").
    4.  Make sure the checkbox next to "Cached images and files" is selected. (You can uncheck others if you only want to clear cache).
    5.  Click the `Clear data` button.
*   **For Mozilla Firefox:**
    1.  Click the three-line menu in the top-right corner.
    2.  Go to `Settings` > `Privacy & Security`.
    3.  Scroll down to the `Cookies and Site Data` section and click `Clear Data...`.
    4.  Make sure "Cached Web Content" is checked.
    5.  Click `Clear`.
*   **For Microsoft Edge:**
    1.  Click the three-dot menu in the top-right corner.
    2.  Go to `Settings` > `Privacy, search, and services`.
    3.  Under `Clear browsing data`, click `Choose what to clear`.
    4.  Select a `Time range`.
    5.  Make sure "Cached images and files" is checked.
    6.  Click `Clear now`.

---

### **Step 2: Test the default repetitions behavior on the "Enter Data - Tabular" page**

After clearing your browser's cache using one of the methods above, please follow these steps to test if the default of '4' for repetitions is working correctly:

1.  **Run the application** (if it's not already running) by typing `node index.js` in your terminal in the `fred-rehab` directory.
2.  Open your web browser and navigate to `http://localhost:3000/enter-data-tabular.html`.
3.  **Select a new date range** (e.g., today's date only, or the last few days that you haven't entered data for yet).
4.  Click the **'Generate Table'** button.
5.  For a date where there's **no existing exercise data** (the "Exercise Done" dropdown will likely default to 'No'):
    *   Change the 'Exercise Done' dropdown for that specific date to **'Yes'**.
    *   **DO NOT manually change the 'Repetitions' dropdown.** Leave it at its initial state (which should be '1' if there was no prior data for that exercise).
6.  Click the **'Save All Data'** button.
7.  **Re-generate the table** for the *same* date range you just tested.
8.  Now, check the 'Repetitions' value for the date(s) you just saved. **It should now display '4' for entries where 'Exercise Done' was set to 'Yes' and you did not manually select a different repetition value.**

The logic is designed such that if 'Exercise Done' is 'Yes' and the repetitions dropdown is either untouched (leaving it at its default '1') or explicitly '0' or empty when 'Save All Data' is clicked, it will save '4'.

Please let me know if, after performing these steps, the default of '4' for repetitions starts working correctly on the "Enter Data - Tabular" page.
