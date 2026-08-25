import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App.jsx'
import Tienda from './components/Tienda.jsx'
import './index.css'

// Detectar si la URL es /tienda/:slug → renderizar tienda pública sin auth
const pathParts = window.location.pathname.split('/').filter(Boolean);
const isTienda  = pathParts[0] === 'tienda' && pathParts[1];

ReactDOM.createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {isTienda ? <Tienda slug={pathParts[1]} /> : <App />}
  </React.StrictMode>,
)
