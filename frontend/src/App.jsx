import { useState } from 'react';
import './App.css';

function App() {
  const [list, setList] = useState([])

  setTimeout(() => {
    setList([
      {
        title: '提示',
        content: '我在干嘛呢'
      },
      {
        title: '提示',
        content: '我在干嘛呢'
      },
      {
        title: '提示',
        content: '我在干嘛呢'
      },
      {
        title: '提示',
        content: '我在干嘛呢'
      }
    ])

  }, 5000)

  // 保存
  const saveClick = (event) => {
    console.log(event)
    event.preventDefault();
  }

  return (
    <div className="App p-4">

      <div className="form-control">
        <div className="input-group">
          <input type="text" placeholder="搜索…" className="input input-bordered input-primary w-full" />
          <label htmlFor="my-modal-2" className="btn btn-primary">新增密码</label>
        </div>
      </div>

      <div className='grid grid-cols-1 gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'>
        {
          list.map((ele, index) =>
            <div className="card shadow-xl" key={index.toString()}>
              <div className="card-body">
                <h2 className="card-title">Card title!</h2>
                <p>If a dog chews shoes whose shoes does he choose?</p>
                <div className="card-actions justify-end pt-4">
                  <div className="btn-group">
                    <button className="btn btn-active">查看</button>
                    <button className="btn btn-outline btn-primary">删除</button>
                  </div>
                </div>
              </div>
            </div>
          )}
      </div>


      <input type="checkbox" id="my-modal-2" className="modal-toggle" />
      <div className="modal">
        <div className="modal-box relative">
          <label htmlFor="my-modal-2" className="btn btn-sm btn-circle absolute right-2 top-2">✕</label>

          <h3 className="font-bold text-lg">我的密码</h3>
          <p className="py-4"></p>

          <div className="form-control">
            <label className="label">
              <span className="label-text">分类</span>
            </label>
            <input type="search" list="category" placeholder="网站" className="input input-bordered w-full" />
            <datalist id="category">
              <option>网站</option>
              <option>银行</option>
              <option>APP</option>
              <option>邮箱</option>
              <option>影音</option>
              <option>社交</option>
              <option>其它</option>
            </datalist>
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">备注信息</span>
            </label>
            <input type="text" placeholder="QQ" className="input input-bordered w-full" />
          </div>

          <div className="form-control">
            <label className="label">
              <span className="label-text">加密内容</span>
            </label>
            <textarea placeholder="账号：&#10;密码：" rows={4} className="textarea textarea-bordered w-full" />
          </div>

          <div className="modal-action">
            <a href="#" className="btn" onClick={saveClick}>保存信息</a>
          </div>
        </div>
      </div>


    </div>
  );
}

export default App;
