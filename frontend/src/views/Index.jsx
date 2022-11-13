import { useState, useEffect } from 'react';
import './Index.css';
import ha from '../homeassistant'

import AddPassword from '../components/AddPassword';
import ShowPassword from '../components/ShowPassword';


export default function App() {

    const [source, setSource] = useState([])
    const [list, setList] = useState([])

    const [info, setInfo] = useState({})

    useEffect(() => {
        ha.getList().then(res => {
            const { data } = res
            setSource(data)
            setList(data)
        })
    }, [])

    const deleteClick = async ({ key }, index) => {
        if (top.confirm("确定删除？")) {
            const res = await ha.delete(key)
            if (res.code == 0) {
                list.splice(index, 1)
                setList(JSON.parse(JSON.stringify(list)))
            }
        }
    }

    const showClick = async ({ key }) => {
        const data = await ha.getInfo(key)
        setInfo(data)
    }

    const search = (val) => {
        const data = val ? source.filter(ele => ele.category.includes(val) || ele.title.includes(val)) : source
        setList(data)
    }

    return (
        <div className="App">

            <div className="navbar shadow-md">

                <div className="navbar-start">
                    <div className="dropdown mr-2">
                        <label tabIndex={0} className="btn btn-ghost btn-circle">
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 6h16M4 12h16M4 18h7" /></svg>
                        </label>
                        <ul tabIndex={0} className="menu menu-compact dropdown-content mt-3 p-2 shadow bg-base-100 rounded-box w-52">
                            <li><a>1还没做</a></li>
                            <li><a>2后面做</a></li>
                            <li><a>3这是分类筛选</a></li>
                        </ul>
                    </div>
                    <div className="form-control">
                        <input type="search" placeholder="搜索..." onChange={e => search(e.target.value)} className="input input-bordered" />
                    </div>
                </div>

                <AddPassword />

            </div>

            <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 p-4'>
                {
                    list.map((item, index) =>
                        <div className="card shadow-xl" key={item.key}>
                            <div className="card-body">
                                <h2 className="card-title">{item.category}</h2>
                                <p>{item.title}</p>
                                <div className="card-actions justify-end pt-4">
                                    <div className="btn-group">
                                        <label htmlFor="my-modal-3" className="btn btn-active" onClick={showClick.bind(this, item)}>查看</label>
                                        <button className="btn btn-outline btn-primary" onClick={deleteClick.bind(this, item, index)}>删除</button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}
            </div>

            <ShowPassword data={info} />
        </div>
    );
}
