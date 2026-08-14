const root = document.querySelector('#root')

async function request(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value.error ?? `请求失败（${response.status}）`)
  return value
}

function authMarkup() {
  return `
    <main class="auth-page">
      <section class="auth-hero">
        <div class="auth-brand"><span>DS</span> DeepSeek Harness</div>
        <h1>你的团队 Agent 工作台</h1>
        <p>租户数据隔离、分布式任务执行，以及集中管理的模型连接配置。</p>
        <div class="auth-points">
          <div><b>1× API</b><span>统一认证与请求接入</span></div>
          <div><b>2× Worker</b><span>Redis 队列分布式执行</span></div>
          <div><b>PostgreSQL</b><span>租户会话与历史持久化</span></div>
        </div>
      </section>
      <section class="auth-card">
        <div class="auth-tabs" role="tablist">
          <button class="active" data-tab="login" type="button">登录</button>
          <button data-tab="register" type="button">创建租户</button>
        </div>
        <form id="login-form" class="auth-form">
          <div><h2>欢迎回来</h2><p>使用租户标识进入团队空间</p></div>
          <label>租户标识<input name="tenantSlug" autocomplete="organization" placeholder="acme-team" required minlength="3"></label>
          <label>用户名<input name="username" autocomplete="username" placeholder="admin" required></label>
          <label>密码<input name="password" type="password" autocomplete="current-password" required></label>
          <p class="form-error" aria-live="polite"></p>
          <button class="primary" type="submit">进入工作台</button>
        </form>
        <form id="register-form" class="auth-form hidden">
          <div><h2>创建团队空间</h2><p>首位用户自动成为租户管理员</p></div>
          <label>团队名称<input name="tenantName" autocomplete="organization" placeholder="示例科技" required minlength="2"></label>
          <label>租户标识<input name="tenantSlug" placeholder="example-team" pattern="[a-z0-9][a-z0-9-]*[a-z0-9]" required minlength="3"><small>小写字母、数字和连字符，登录时需要使用</small></label>
          <label>管理员用户名<input name="username" autocomplete="username" placeholder="admin" required></label>
          <label>密码<input name="password" type="password" autocomplete="new-password" required minlength="8"><small>至少 8 个字符</small></label>
          <p class="form-error" aria-live="polite"></p>
          <button class="primary" type="submit">创建并进入</button>
        </form>
      </section>
    </main>`
}

function showAuth() {
  document.body.classList.add('distributed-auth-mode')
  root.innerHTML = authMarkup()
  const tabs = [...document.querySelectorAll('[data-tab]')]
  const forms = {
    login: document.querySelector('#login-form'),
    register: document.querySelector('#register-form'),
  }
  for (const tab of tabs) {
    tab.addEventListener('click', () => {
      for (const item of tabs) item.classList.toggle('active', item === tab)
      for (const [name, form] of Object.entries(forms)) form.classList.toggle('hidden', name !== tab.dataset.tab)
    })
  }
  for (const [kind, form] of Object.entries(forms)) {
    form.addEventListener('submit', async (event) => {
      event.preventDefault()
      const submit = form.querySelector('[type="submit"]')
      const error = form.querySelector('.form-error')
      const data = Object.fromEntries(new FormData(form))
      submit.disabled = true
      submit.textContent = kind === 'login' ? '正在登录…' : '正在创建…'
      error.textContent = ''
      try {
        await request(`/auth/${kind}`, { method: 'POST', body: JSON.stringify(data) })
        location.reload()
      } catch (reason) {
        error.textContent = reason instanceof Error ? reason.message : String(reason)
      } finally {
        submit.disabled = false
        submit.textContent = kind === 'login' ? '进入工作台' : '创建并进入'
      }
    })
  }
}

function addWorkspaceChrome(session) {
  const nav = document.createElement('aside')
  nav.className = 'tenant-nav'
  nav.innerHTML = `
    <div class="tenant-copy"><strong></strong><span></span></div>
    <button data-logout type="button">退出</button>`
  nav.querySelector('strong').textContent = session.tenant.name
  nav.querySelector('span').textContent = `${session.tenant.slug} · ${session.user.username}`
  document.body.append(nav)
  nav.querySelector('[data-logout]').addEventListener('click', async () => {
    await request('/auth/logout', { method: 'POST', body: '{}' }).catch(() => undefined)
    location.reload()
  })
}

try {
  const session = await request('/auth/session')
  addWorkspaceChrome(session)
  await import(window.__DSH_DISTRIBUTED_SHELL__)
} catch (error) {
  if (error instanceof TypeError) {
    root.innerHTML = `<main class="fatal-error"><h1>前端加载失败</h1><p>${error.message}</p></main>`
  } else {
    showAuth()
  }
}
