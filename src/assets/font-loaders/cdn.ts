export const loadFonts = () => {
  const createLink = (href: string) => {
    const link = document.createElement('link')
    link.rel = 'stylesheet'
    link.href = href
    link.media = 'print'
    link.onload = () => {
      link.media = 'all'
    }
    document.head.appendChild(link)
  }

  createLink('https://unpkg.com/subsetted-fonts@latest/MiSans-VF/MiSans-VF.css')
  createLink('https://unpkg.com/subsetted-fonts@latest/SarasaUiSC-Regular/SarasaUiSC-Regular.css')
  createLink('https://unpkg.com/subsetted-fonts@latest/PingFangSC-Regular/PingFangSC-Regular.css')
  createLink('https://unpkg.com/@fontsource/fira-sans')
}
