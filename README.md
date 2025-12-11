# Fred Rehab Application

This is a simple Node.js Express application for Fred's rehab center.

## Setup

1.  **Initialize Node.js project and install dependencies:**
    ```bash
    cd fred-rehab
    npm init -y
    npm install express
    ```
2.  **Create `index.js`:**
    ```javascript
    const express = require('express');
    const app = express();
    const port = 3000;

    app.get('/', (req, res) => {
      res.send('Hello from Fred Rehab!');
    });

    app.listen(port, () => {
      console.log(`Fred Rehab app listening at http://localhost:${port}`);
    });
    ```
3.  **Create `Dockerfile`:**
    ```dockerfile
    # Use an official Node.js runtime as a parent image
    FROM node:18-alpine

    # Set the working directory in the container to /app
    WORKDIR /app

    # Copy package.json and package-lock.json to the working directory
    COPY package*.json ./

    # Install any needed packages
    RUN npm install

    # Copy the rest of the application code to the working directory
    COPY . .

    # Make port 3000 available to the world outside this container
    EXPOSE 3000

    # Run the web app
    CMD [ "node", "index.js" ]
    ```
4.  **Create `.dockerignore`:**
    ```
    node_modules
    npm-debug.log
    .DS_Store
    .git
    .gitignore
    ```

## Running the Application (Local)

To run the application directly (without Docker):

```bash
cd fred-rehab
node index.js
```

Then, open your browser to `http://localhost:3000`.

## Running the Application (with Docker)

**Note:** The `docker` command was not found in the environment where this application was set up, so these steps are provided for a system with Docker installed.

1.  **Build the Docker image:**
    ```bash
    cd fred-rehab
    docker build -t fred-rehab .
    ```
2.  **Run the Docker container:**
    ```bash
    docker run -p 3000:3000 fred-rehab
    ```

Then, open your browser to `http://localhost:3000`.
