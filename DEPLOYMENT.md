# Deployment Instructions for Fred's Rehab Tracker

This document outlines various ways to deploy the Fred's Rehab Tracker application to a production environment. The best method depends on your technical expertise, budget, and desired scalability.

## Option 1: Simple Server (e.g., a VPS or Raspberry Pi)

This is a straightforward approach for small-scale deployments.

**Prerequisites:**
*   A server running a Linux distribution (e.g., Ubuntu, Debian).
*   Node.js and npm installed on the server.
*   Basic command-line knowledge.

**Steps:**

1.  **Transfer your application files to the server.**
    You can use `scp` (Secure Copy Protocol) or `rsync` to transfer the `fred-rehab` directory to your server.
    ```bash
    scp -r fred-rehab user@your_server_ip:/path/to/destination
    ```

2.  **Install dependencies on the server.**
    SSH into your server and navigate to the application directory:
    ```bash
    ssh user@your_server_ip
    cd /path/to/destination/fred-rehab
    npm install
    ```

3.  **Run the application.**
    You can simply run the application using `node`:
    ```bash
    node index.js
    ```
    However, this will stop the application if your SSH session closes. For continuous operation, use a process manager like `pm2`.

4.  **Install and use PM2 (Process Manager 2).**
    PM2 is a production process manager for Node.js applications with a built-in load balancer.
    ```bash
    npm install pm2 -g
    pm2 start index.js --name "fred-rehab-app"
    pm2 save
    pm2 startup
    ```
    Follow the `pm2 startup` instructions to ensure your application starts automatically on server reboot.

5.  **Configure a reverse proxy (e.g., Nginx or Apache - Optional but Recommended).**
    To serve your application on a standard web port (like 80 or 443) and handle SSL certificates, you'll want a reverse proxy.

    *   **Nginx Example:**
        Install Nginx: `sudo apt update && sudo apt install nginx`
        Create a new Nginx configuration file: `sudo nano /etc/nginx/sites-available/fred-rehab`
        Add the following content (replace `your_domain_or_ip`):
        ```nginx
        server {
            listen 80;
            server_name your_domain_or_ip;

            location / {
                proxy_pass http://localhost:3000; # Port your Node.js app is running on
                proxy_http_version 1.1;
                proxy_set_header Upgrade $http_upgrade;
                proxy_set_header Connection 'upgrade';
                proxy_set_header Host $host;
                proxy_cache_bypass $http_upgrade;
            }
        }
        ```
        Enable the site and restart Nginx:
        ```bash
        sudo ln -s /etc/nginx/sites-available/fred-rehab /etc/nginx/sites-enabled/
        sudo systemctl restart nginx
        ```

## Option 2: Platform as a Service (PaaS)

PaaS providers simplify deployment by handling the underlying infrastructure. You push your code, and they deploy it.

**Advantages:**
*   Easier setup and maintenance.
*   Automatic scaling and load balancing.
*   Built-in CI/CD (Continuous Integration/Continuous Deployment).

**General Steps:**

1.  **Sign up for a PaaS provider account** (e.g., Heroku, Render.com).
2.  **Install their CLI tool** (if available and preferred).
3.  **Connect your Git repository** (e.g., GitHub, GitLab). Most PaaS platforms integrate directly with Git.
4.  **Configure deployment settings.** You might need to specify:
    *   Build command (e.g., `npm install`)
    *   Start command (e.g., `node index.js`)
    *   Environment variables (e.g., `PORT` - many PaaS automatically set this).
5.  **Deploy!** A simple `git push` to the platform's remote often triggers a deployment.

### Option 2.1: Deploying to Render (with SQLite Persistent Disk)

Render is a popular PaaS that makes deploying Node.js applications easy. Since this application uses SQLite (a file-based database), we need to configure Render's Persistent Disk feature to ensure your data (`rehab.db`) is not lost on deploys or restarts.

**Steps for Render Deployment:**

1.  **Prepare your Git Repository:**
    *   Ensure your `fred-rehab` project is in a Git repository (e.g., GitHub, GitLab). Render will deploy directly from your repo.

2.  **Create a Render Account:**
    *   If you don't have one, sign up at [https://render.com/](https://render.com/).

3.  **Create a New Web Service on Render:**
    *   Log in to your Render dashboard.
    *   Click 'New' -> 'Web Service'.
    *   **Connect your Git repository:** Link your GitHub/GitLab account and select the repository containing your `fred-rehab` project.
    *   **Auto Deploy:** You can choose 'Auto-Deploy' to automatically redeploy every time you push changes to your Git branch.

4.  **Configure your Web Service Settings:**
    *   **Name:** `fred-rehab-app` (or any name you prefer).
    *   **Region:** Choose a region close to you or your users.
    *   **Branch:** The Git branch you want to deploy (e.g., `main` or `master`).
    *   **Root Directory:** If your `fred-rehab` project is in a subdirectory of your repo, specify it here (e.g., `/fred-rehab`). If it's at the root, leave blank.
    *   **Runtime:** `Node`
    *   **Build Command:** `npm install`
    *   **Start Command:** `node index.js`
    *   **Port:** `3000` (This matches the port your `index.js` listens on).

5.  **Configure Persistent Disk for SQLite (Crucial for Data Persistence):**
    *   In your Web Service settings on Render, navigate to the 'Disks' section.
    *   Click 'Add Disk'.
    *   **Name:** `rehab-data` (or any descriptive name).
    *   **Mount Path:** `/var/data` (This is where Render will make the persistent disk available inside your application container).
    *   **Size:** Start with `1 GB` (or more if you expect a lot of video uploads, as videos are also saved locally).

6.  **Update `index.js` to use the Persistent Disk for `rehab.db`:**
    *   Since Render mounts the persistent disk at `/var/data`, your `rehab.db` file needs to be stored there.
    *   You'll need to modify your `index.js` file:
        *   Change `const db = new sqlite3.Database('./rehab.db', ...);`
        *   To `const db = new sqlite3.Database(process.env.DATABASE_PATH || './rehab.db', ...);`
    *   Then, on Render, add an **Environment Variable**:
        *   **Key:** `DATABASE_PATH`
        *   **Value:** `/var/data/rehab.db`

7.  **Update `index.js` for `public/uploads` path (for videos):**
    *   Similarly, for video uploads, you want them to be persistent.
    *   Change `cb(null, 'public/uploads/')` in the multer `destination` function to use the persistent disk.
    *   You'll need to modify your `index.js` file:
        *   Change `cb(null, 'public/uploads/')`
        *   To `cb(null, process.env.UPLOAD_PATH || 'public/uploads/')`
    *   Then, on Render, add another **Environment Variable**:
        *   **Key:** `UPLOAD_PATH`
        *   **Value:** `/var/data/uploads`
    *   **Important:** You'll also need to create an `uploads` directory within the persistent disk on Render. This usually means adding a simple shell command to your Build Command on Render: `npm install && mkdir -p /var/data/uploads`

8.  **Deploy your Service:**
    *   Click 'Create Web Service'. Render will then pull your code, run the build command, and start your service.

**Important Notes for Render Deployment:**

*   **Free Tier Limitations:** Render's free tier has limitations (e.g., spin-down after inactivity). For consistent uptime, you'll need a paid plan.
*   **Manual Migration:** If you have an existing `rehab.db` file from local development that contains data you want to preserve, you'll need to manually upload it to your Render Persistent Disk. Render provides SFTP access for this.
*   **Security:** Ensure sensitive data is handled with environment variables, not hardcoded.

## Option 3: Docker and Container Orchestration (e.g., Kubernetes, Docker Swarm)

## Option 3: Docker and Container Orchestration (e.g., Kubernetes, Docker Swarm)

This offers the most control and scalability but is also the most complex. It leverages the `Dockerfile` you've already created.

**Prerequisites:**
*   Docker installed on your production server(s).
*   Knowledge of Docker commands.
*   (For orchestration) A Kubernetes cluster or Docker Swarm setup.

**Steps:**

1.  **Build the Docker image.**
    On your server or local machine:
    ```bash
    cd fred-rehab
    docker build -t fred-rehab-app .
    ```

2.  **Run the Docker container.**
    ```bash
    docker run -d -p 80:3000 --name fred-rehab-container fred-rehab-app
    ```
    This will run the container in detached mode (`-d`), map port 80 on the host to port 3000 in the container (`-p 80:3000`), name the container, and use the image you just built.

3.  **Push to a Container Registry (for orchestration/multiple servers).**
    If you're using Kubernetes or multiple servers, you'll push your image to a registry (e.g., Docker Hub, Google Container Registry, AWS ECR).
    ```bash
    docker tag fred-rehab-app your_registry/fred-rehab-app:latest
    docker push your_registry/fred-rehab-app:latest
    ```

4.  **Deploy with Orchestration (Kubernetes Example).**
    You would define a Deployment and Service in YAML files, referencing your image from the registry.

    *   **deployment.yaml:**
        ```yaml
        apiVersion: apps/v1
        kind: Deployment
        metadata:
          name: fred-rehab-deployment
        spec:
          replicas: 1
          selector:
            matchLabels:
              app: fred-rehab
          template:
            metadata:
              labels:
                app: fred-rehab
            spec:
              containers:
              - name: fred-rehab-container
                image: your_registry/fred-rehab-app:latest
                ports:
                - containerPort: 3000
        ```

    *   **service.yaml:**
        ```yaml
        apiVersion: v1
        kind: Service
        metadata:
          name: fred-rehab-service
        spec:
          selector:
            app: fred-rehab
          ports:
            - protocol: TCP
              port: 80
              targetPort: 3000
          type: LoadBalancer # Or NodePort, ClusterIP depending on your needs
        ```
    Apply these to your cluster:
    ```bash
    kubectl apply -f deployment.yaml
    kubectl apply -f service.yaml
    ```

## Important Considerations:

*   **Security:** Always use HTTPS for production sites. Use tools like Certbot with Nginx/Apache, or leverage PaaS built-in SSL.
*   **Environment Variables:** Never hardcode sensitive information. Use environment variables (e.g., for database credentials). PaaS providers and orchestration systems have mechanisms for managing these securely.
*   **Error Logging and Monitoring:** Set up robust logging and monitoring (e.g., using a service like Sentry, LogRocket, or cloud-provider specific tools) to quickly identify and resolve issues.
*   **Database:** For production, ensure your SQLite database (`rehab.db`) is handled appropriately. For more scalable solutions, consider a hosted database service (e.g., AWS RDS, Google Cloud SQL) instead of a local file-based database. If using SQLite on a single server, ensure proper backups are in place.

Choose the option that best fits your needs and technical comfort level. Good luck!
