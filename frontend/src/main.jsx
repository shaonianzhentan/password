import React from 'react'
import ReactDOM from 'react-dom/client'
import {
  createHashRouter,
  RouterProvider,
} from "react-router-dom";
import './index.css'
import Login from './views/Login'
import Index from './views/Index'

const router = createHashRouter([
  {
    path: "/",
    element: <Login />
  },
  {
    path: "/index",
    element: <Index />
  },
]);

ReactDOM.createRoot(document.getElementById("root")).render(
  <RouterProvider router={router} />
);