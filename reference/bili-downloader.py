import os
import time
import argparse
import requests
from tqdm import tqdm
from threading import Thread
from datetime import datetime
from moviepy import VideoFileClip, AudioFileClip

nowtime = datetime.now()
chunk_size = 4*1024*1024    # 4MB
thread_results = []
USER_AGENT = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36"

def get_size(url, referer):
    headers = {
        'user-agent': USER_AGENT,
        'referer': referer,
        'range': 'bytes=0-0'
    }
    for attempt in range(1, 6):
        try:
            res = requests.get(url, headers=headers)
            if res.status_code in (200, 206):
                size = None
                content_range = res.headers.get("Content-Range")
                if content_range and "/" in content_range:
                    size = int(content_range.rsplit("/", 1)[1])
                if size is None:
                    content_length = res.headers.get("Content-Length")
                    if content_length:
                        size = int(content_length)
                if size is not None:
                    return size
        except Exception:
            pass
        if attempt < 5:
            print(f"Failed to get file size, retry {attempt}/5 ...")
            time.sleep(2 * attempt)
    raise RuntimeError("无法获取文件大小")

def split_ranges(filesize, jobs):
    sizelist = [filesize//jobs for i in range(jobs)]
    for i in range(filesize % jobs):
        sizelist[i] += 1
    sizeranges = []
    for i in range(jobs):
        if i == 0:
            sizeranges.append((0, sizelist[i]-1))
        else:
            sizeranges.append((sizeranges[i-1][1]+1, sizeranges[i-1][1]+sizelist[i]))
    return sizeranges

def thread_download(url, referer, output_file, sizerange, taskid):
    thread_file = output_file + '_part' + str(taskid).zfill(3)

    chunks = -(-(sizerange[1] - sizerange[0] + 1)//chunk_size)
    chunk_ranges = []
    for i in range(chunks-1):
        chunk_ranges.append((sizerange[0] + i*chunk_size, sizerange[0] + (i+1)*chunk_size-1))
    chunk_ranges.append((sizerange[0] + (chunks - 1)*chunk_size, sizerange[1]))

    thread_success = True
    pbar = tqdm(total=chunks, desc=f"Thread {taskid}", position=taskid)
    with open(thread_file, 'ab') as f:
        for i in range(chunks):
            headers = {
                'user-agent': USER_AGENT,
                'referer': referer,
                'range': f"bytes={chunk_ranges[i][0]}-{chunk_ranges[i][1]}"
            }
            chunk_success = False
            for attempt in range(1, 6):
                try:
                    data = requests.get(url=url, headers=headers).content
                    f.write(data)
                    chunk_success = True
                    break
                except Exception:
                    time.sleep(2**attempt)
            if not chunk_success:
                thread_success = False
                break
            pbar.update(1)
    pbar.close()
    thread_results[taskid] = thread_success


def download(url, referer, output_file, jobs):
    global thread_results
    thread_results = []
    for i in range(jobs):
        thread_results.append(False)
    filesize = get_size(url, referer)
    sizeranges = split_ranges(filesize, jobs)

    print(f"Downloading to {output_file}...")
    print(f"filesize: {filesize}")
    print(f"jobs: {jobs}")
    print(f"size ranges:")
    for i in range(jobs):
        print(f"    thread {i}: bytes={sizeranges[i][0]}-{sizeranges[i][1]}, {(sizeranges[i][1]-sizeranges[i][0]+1)/(2**20)}MB")

    threads = []
    for i in range(jobs):
        t = Thread(target=thread_download, args=(url, referer, output_file, sizeranges[i], i))
        t.start()
        threads.append(t)
    for t in threads:
        t.join()

    download_success = True
    with open(output_file, 'ab') as f:
        for i in range(jobs):
            if not thread_results[i]:
                print("download merge failed at thread {i}.")
                download_success = False
                break
            else:
                thread_filepath = output_file + '_part' + str(i).zfill(3)
                with open(thread_filepath, 'rb') as f2:
                    f.write(f2.read())
                os.remove(thread_filepath)
    if download_success:
        print(f"Successfully download to {output_file}.")
    else:
        print(f"Failed to download to {output_file}.")

    return download_success

def merge_audio_video(file1, file2, output_file):
    size1 = os.path.getsize(file1)
    size2 = os.path.getsize(file2)
    if size1 > size2:
        video_file = file1
        audio_file = file2
    else:
        video_file = file2
        audio_file = file1
    try:
        # load video and audio
        video_clip = VideoFileClip(video_file)
        audio_clip = AudioFileClip(audio_file)
        # insert audio to video
        final_clip = video_clip.with_audio(audio_clip)
        # write to output_file, use codec='libx264' and audio_codec='aac'
        final_clip.write_videofile(output_file, codec='libx264', audio_codec='aac')
        print(f"merge successfully: {output_file}")
        # close resources
        video_clip.close()
        audio_clip.close()
        final_clip.close()
        return True
    except Exception as e:
        print(f"merge failed: {e}")
        return False

def main():
    parser = argparse.ArgumentParser(epilog=f"Example: python {os.path.basename(__file__)} -u https://www.bilibili.com -u2 https://www.bilibili.com -r https://www.bilibili.com -o test.mp4")
    parser.add_argument('-u', '--url', required=True, help='The bilibili url1')
    parser.add_argument('-u2', '--url2', default='', help='The bilibili url2')
    parser.add_argument('-r', '--referer', required=True, help='The referer url')
    parser.add_argument('-r2', '--referer2', default='', help='The referer url2')
    parser.add_argument('-o', '--output', default=f"bili_output_url1_{nowtime.strftime('%Y%m%d%H%M%S')}.mp4", help='The output file path')
    parser.add_argument('-o2', '--output2', default=f"bili_output_url2_{nowtime.strftime('%Y%m%d%H%M%S')}.mp4", help='The second output file path')
    parser.add_argument('-n', '--not-merge', action='store_true', help='Do not merge the two file')
    parser.add_argument('-mo', '--merge-output', default=f"bili_output_merge_{nowtime.strftime('%Y%m%d%H%M%S')}.mp4", help='The merge output')
    parser.add_argument('-rm', '--remove', action='store_true', help='Remove video and audio file')
    parser.add_argument('-j', '--jobs', type=int, default=1, help='The jobs to download')
    
    args = parser.parse_args()
    url1 = args.url
    referer1 = args.referer
    output1 = args.output
    url2 = args.url2
    referer2 = args.referer2
    output2 = args.output2
    merge_output = args.merge_output
    jobs = args.jobs
    has_url2 = True
    need_merge = True
    need_remove = False
    if url2 == '':
        has_url2 = False
        need_merge = False
    if referer2 == '':
        referer2 = referer1
    if args.not_merge:
        need_merge = False
    if args.remove and has_url2:
        need_remove = True

    download_res1 = False
    download_res2 = False
    download_res1 = download(url1, referer1, output1, jobs)
    if has_url2:
        download_res2 = download(url2, referer2, output2, jobs)
    if need_merge:
        if download_res1 and download_res2:
            merge_audio_video(output1, output2, merge_output)
        else:
            print("Some one have not been downloaded successfully, CAN NOT merge.")
    if need_remove:
        if download_res1 and download_res2:
            os.remove(output1)
            os.remove(output2)
        else:
            print("Some one have not been downloaded successfully, CAN NOT remove.")
if __name__ == '__main__':
    main()
