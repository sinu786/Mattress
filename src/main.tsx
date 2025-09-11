import React from 'react'
import { createRoot } from 'react-dom/client'
import App from './ui/App'
// in src/main.tsx or src/index.tsx
import './ui/app.css'


createRoot(document.getElementById('root')!).render(<App />)
