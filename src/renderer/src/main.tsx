import { createRoot } from 'react-dom/client'
import '@fontsource-variable/roboto-flex/full.css'
import '@fontsource-variable/google-sans-flex/full.css'
import '@fontsource-variable/fraunces/full.css'
import './styles/app.css'
import { App } from './components/App'

createRoot(document.getElementById('root')!).render(<App />)
