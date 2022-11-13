import { useState } from 'react';
import './Login.css';
import ha from '../homeassistant'

function App() {

    const [key, setKey] = useState('')

    const handleCnhange = (e) => setKey(e.target.value)

    const loginClick = async () => {
        if (!key) return top.alert("请输入密钥")

        const res = await ha.login(key)
        if (res.code == '0') {
            location.hash = '#/index'
        } else {
            top.alert("密钥错误！")
        }
    }

    return (
        <div className="Login p-4">

            <div className="card md:w-96 bg-base-100 shadow-xl mx-auto mt-8">
                <figure className="px-10 pt-10">
                    <img src="https://placeimg.com/400/225/arch" alt="Shoes" className="rounded-xl" />
                </figure>
                <div className="card-body items-center text-center">
                    <h2 className="card-title">MY PASSWORD</h2>
                    <input type="text" placeholder="密钥" value={key} onChange={handleCnhange} className="input input-bordered w-full my-4" />
                    <div className="card-actions">
                        <button className="btn btn-primary" onClick={loginClick}>登录</button>
                    </div>
                </div>
            </div>

        </div>
    );
}

export default App;
