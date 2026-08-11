import { mount } from 'svelte';
import DesktopRoot from './DesktopRoot.svelte';
import './styles.css';

mount(DesktopRoot, { target: document.getElementById('app')! });
